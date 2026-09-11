/**
 * M2: the ledger under Paperclip's plugin rules. Every statement the core
 * issues in statements mode goes through Paperclip's own validators first
 * (when the runtime checkout is present), then runs against pglite with the
 * generated plugin migration in the real namespace.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb, PLUGIN_NAMESPACE } from './harness.js';
import {
  ACCOUNT,
  LedgerError,
  accountBalances,
  balanceOf,
  cleanupPending,
  listTransactions,
  position,
  postReversal,
  postTransaction,
  readCursor,
  seedAccounts,
  sweepCosts,
  trialBalance,
} from '../src/core/index.js';
import { categorise, paperclipCostSource } from '../src/plugin/cost-source.js';

const CO = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AGENT = '33333333-3333-4333-8333-333333333333';

let db: PluginTestDb;

async function addCost(companyId: string, cents: number, extra: Record<string, unknown> = {}): Promise<string> {
  const cols = { company_id: companyId, cost_cents: cents, provider: 'anthropic', model: 'claude-sonnet-5', billing_type: 'metered_api', ...extra };
  const keys = Object.keys(cols);
  const r = await db.raw.query<{ id: string }>(
    `INSERT INTO public.cost_events (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    keys.map((k) => cols[k as keyof typeof cols]),
  );
  return r.rows[0]!.id;
}

beforeAll(async () => {
  db = await openPluginTestDb();
  if (!db.validated) console.warn('Paperclip runtime not found next door: SQL validators skipped');
  await seedAccounts(db, CO, 'USD');
  await seedAccounts(db, OTHER, 'USD');
});

afterAll(async () => {
  await db.close();
});

describe('M2 · plugin schema', () => {
  it('lives in the namespace Paperclip derives for ai3.ledger', async () => {
    const r = await db.raw.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM information_schema.tables WHERE table_schema = $1`,
      [PLUGIN_NAMESPACE],
    );
    expect(Number(r.rows[0]!.n)).toBeGreaterThanOrEqual(9);
  });

  it('ran every migration statement through the host validators', () => {
    expect(db.posting).toBe('statements');
    expect(db.validated || process.env['CI'] === undefined).toBe(true);
  });
});

describe('M2 · statements-mode posting', () => {
  it('posts a balanced transaction with no function call', async () => {
    const r = await postTransaction(db, {
      companyId: CO,
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      description: 'Seed funding',
      sourcePlatform: 'manual',
      sourceKind: 'funding',
      sourceRef: 'fund-1',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100_000n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 100_000n },
      ],
    });
    expect(r.inserted).toBe(true);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(100_000n);
    const status = await db.raw.query<{ status: string }>(`SELECT status FROM "${PLUGIN_NAMESPACE}".transactions WHERE id = $1`, [r.transactionId]);
    expect(status.rows[0]!.status).toBe('posted');
  });

  it('treats a repeated source ref as a no-op', async () => {
    const again = await postTransaction(db, {
      companyId: CO,
      occurredAt: new Date('2026-09-01T00:00:00Z'),
      sourcePlatform: 'manual',
      sourceKind: 'funding',
      sourceRef: 'fund-1',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100_000n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 100_000n },
      ],
    });
    expect(again.inserted).toBe(false);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(100_000n);
  });

  it('rejects an unknown account and leaves nothing behind', async () => {
    await expect(
      postTransaction(db, {
        companyId: CO,
        occurredAt: new Date(),
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        sourceRef: 'bad-1',
        currency: 'USD',
        entries: [
          { accountCode: '9999', direction: 'debit', amountMinor: 5n },
          { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 5n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unknown_account' });
    const left = await db.raw.query<{ n: string }>(`SELECT count(*)::text AS n FROM "${PLUGIN_NAMESPACE}".transactions WHERE source_ref = 'bad-1'`);
    expect(left.rows[0]!.n).toBe('0');
  });

  it('ignores a pending transaction in every report and sweeps it away when stale', async () => {
    await db.raw.query(
      `INSERT INTO "${PLUGIN_NAMESPACE}".transactions (company_id, occurred_at, source_platform, source_kind, source_ref, status, created_at)
       VALUES ($1, now(), 'manual', 'manual', 'ghost', 'pending', now() - interval '1 hour')`,
      [CO],
    );
    const before = await trialBalance(db, CO);
    const removed = await cleanupPending(db, 10);
    expect(removed).toBe(1);
    const after = await trialBalance(db, CO);
    expect(after.entryCount).toBe(before.entryCount);
  });

  it('refuses a transaction dated inside a closed period', async () => {
    await db.raw.query(
      `INSERT INTO "${PLUGIN_NAMESPACE}".periods (company_id, starts_on, ends_on, status, closed_at) VALUES ($1, '2020-01-01', '2020-01-31', 'closed', now())`,
      [CO],
    );
    await expect(
      postTransaction(db, {
        companyId: CO,
        occurredAt: new Date('2020-01-15T00:00:00Z'),
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        currency: 'USD',
        entries: [
          { accountCode: ACCOUNT.OTHER_OPERATING, direction: 'debit', amountMinor: 1n },
          { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 1n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'period_closed', message: expect.stringContaining('2020-01-01..2020-01-31') });
  });

  it('reverses through a mirror transaction', async () => {
    const t = await postTransaction(db, {
      companyId: CO,
      occurredAt: new Date('2026-09-02T00:00:00Z'),
      sourcePlatform: 'manual',
      sourceKind: 'manual',
      sourceRef: 'rev-src',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.OTHER_OPERATING, direction: 'debit', amountMinor: 700n },
        { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 700n },
      ],
    });
    const before = await balanceOf(db, CO, ACCOUNT.TREASURY);
    const r = await postReversal(db, CO, t.transactionId);
    expect(r.inserted).toBe(true);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(before + 700n);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
  });
});

describe('M2 · Paperclip cost sweep', () => {
  it('maps cost events to expense accounts', () => {
    expect(categorise({ model: 'claude-sonnet-5', provider: 'anthropic', billing_type: 'metered_api', biller: null })).toBe('model');
    expect(categorise({ model: null, provider: 'e2b', billing_type: 'metered_api', biller: 'sandbox' })).toBe('compute');
    expect(categorise({ model: null, provider: 'exa', billing_type: 'metered_api', biller: 'search api' })).toBe('tool');
    expect(categorise({ model: null, provider: null, billing_type: 'unknown', biller: null })).toBe('other');
  });

  it('AC1: after a sweep the expense accounts total exactly the window and every transaction balances', async () => {
    await addCost(CO, 1234, { agent_id: AGENT });
    await addCost(CO, 66, { agent_id: AGENT });
    await addCost(CO, 0, { cost_status: 'unpriced', model: null, provider: null, billing_type: 'subscription_included' });
    await addCost(CO, 500, { model: null, provider: 'e2b', biller: 'sandbox' });
    await addCost(OTHER, 999);

    const r = await sweepCosts(db, paperclipCostSource(db.sql), CO, { currency: 'USD' });
    expect(r.read).toBe(4);
    expect(r.posted).toBe(3);
    expect(r.skipped).toBe(1);

    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(1300n);
    expect(await balanceOf(db, CO, ACCOUNT.COMPUTE_AND_SANDBOXES)).toBe(500n);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
    const treasury = await balanceOf(db, CO, ACCOUNT.TREASURY);
    expect(treasury).toBe(100_000n - 1800n);
  });

  it('AC2: running the sweep twice creates no duplicate transactions', async () => {
    const r = await sweepCosts(db, paperclipCostSource(db.sql), CO, { currency: 'USD' });
    expect(r.read).toBe(0);
    expect(r.posted).toBe(0);
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(1300n);
  });

  it('AC3: deleting the cursor and re-sweeping creates no duplicate transactions', async () => {
    await db.raw.query(`DELETE FROM "${PLUGIN_NAMESPACE}".sweep_cursor WHERE company_id = $1`, [CO]);
    expect((await readCursor(db, CO, 'paperclip')).lastEventRef).toBeNull();
    const r = await sweepCosts(db, paperclipCostSource(db.sql), CO, { currency: 'USD' });
    expect(r.read).toBe(4);
    expect(r.posted).toBe(0);
    expect(r.duplicates).toBe(3);
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(1300n);
    expect((await readCursor(db, CO, 'paperclip')).lastEventRef).not.toBeNull();
  });

  it('carries the agent onto the entries and filters transactions by agent', async () => {
    const mine = await listTransactions(db, CO, { agentRef: AGENT });
    expect(mine.length).toBe(2);
    expect(mine.every((t) => t.entries.every((e) => e.subject.agent === AGENT))).toBe(true);
  });

  it('AC10: the other company sees only its own costs', async () => {
    const r = await sweepCosts(db, paperclipCostSource(db.sql), OTHER, { currency: 'USD' });
    expect(r.posted).toBe(1);
    expect(await balanceOf(db, OTHER, ACCOUNT.MODEL_INFERENCE)).toBe(999n);
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(1300n);
    const rows = await accountBalances(db, 'nobody');
    expect(rows).toEqual([]);
  });
});

describe('M2 · position', () => {
  it('AC9: an empty company renders without inventing figures', async () => {
    const EMPTY = '44444444-4444-4444-8444-444444444444';
    await seedAccounts(db, EMPTY, 'USD');
    const p = await position(db, EMPTY);
    expect(p.treasuryMinor).toBe('0');
    expect(p.monthToDate.expenseMinor).toBe('0');
    expect(p.runwayDays).toBeNull();
    expect(p.balanceSheet.balances).toBe(true);
    expect(p.accounts.length).toBe(11);
  });

  it('reports treasury, burn and runway from posted entries and the balance sheet balances', async () => {
    const p = await position(db, CO, new Date());
    expect(p.treasuryMinor).toBe(String(100_000 - 1800));
    expect(p.trailing30d.expenseMinor).toBe('1800');
    expect(p.runwayDays).toBe(Math.floor((100_000 - 1800) / Math.floor(1800 / 30)));
    expect(p.balanceSheet.balances).toBe(true);
    expect(p.trial.netMinor).toBe('0');
  });

  it('marks a LedgerError as such', () => {
    expect(new LedgerError('x', 'invalid')).toBeInstanceOf(Error);
  });
});
