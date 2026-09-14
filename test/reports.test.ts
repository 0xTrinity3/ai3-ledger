/**
 * M4: periods, profit and loss, balance sheet. Under the plugin rules, like M3.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT,
  balanceSheet,
  closePeriod,
  createCustomer,
  createInvoice,
  createPeriod,
  ensureMonth,
  issueInvoice,
  listPeriods,
  monthBounds,
  postTransaction,
  profitAndLoss,
  recordPayment,
  seedAccounts,
  sweepCosts,
} from '../src/core/index.js';
import { paperclipCostSource } from '../src/plugin/cost-source.js';

const CO = '88888888-8888-4888-8888-888888888888';
const AGENT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AGENT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let db: PluginTestDb;

async function fund(amount: bigint, at: string, ref: string) {
  return postTransaction(db, {
    companyId: CO, occurredAt: at, sourcePlatform: 'manual', sourceKind: 'funding', sourceRef: ref, currency: 'USD', description: 'Funding',
    entries: [
      { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: amount },
      { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: amount },
    ],
  });
}

async function addCost(cents: number, agent: string, at: string) {
  await db.raw.query(
    `INSERT INTO public.cost_events (company_id, agent_id, provider, model, billing_type, cost_status, cost_cents, occurred_at, created_at)
     VALUES ($1, $2, 'anthropic', 'claude-sonnet-5', 'metered_api', 'reported', $3, $4, $4)`,
    [CO, agent, cents, at],
  );
}

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  await fund(500_000n, '2026-07-01T00:00:00Z', 'fund-jul');
  await addCost(1_000, AGENT_A, '2026-07-10T00:00:00Z');
  await addCost(2_000, AGENT_B, '2026-07-20T00:00:00Z');
  await addCost(4_000, AGENT_A, '2026-08-05T00:00:00Z');
  await sweepCosts(db, paperclipCostSource(db.sql), CO, { currency: 'USD' });
  const c = await createCustomer(db, CO, { name: 'Client One' });
  const inv = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'July work', unitAmountMinor: 90_000 }], subject: { agent: AGENT_A } });
  await issueInvoice(db, CO, inv.id, { issuedAt: '2026-07-25T00:00:00Z' });
  await recordPayment(db, CO, inv.id, { amountMinor: 90_000, occurredAt: '2026-08-15T00:00:00Z', reference: 'wire-1' });
});

afterAll(async () => {
  await db.close();
});

describe('M4 · periods', () => {
  it('knows month bounds', () => {
    expect(monthBounds('2026-02')).toEqual({ startsOn: '2026-02-01', endsOn: '2026-02-28' });
    expect(monthBounds('2028-02').endsOn).toBe('2028-02-29');
  });

  it('creates months idempotently and refuses overlaps', async () => {
    const jul = await ensureMonth(db, CO, '2026-07');
    expect(jul.label).toBe('2026-07-01..2026-07-31');
    expect((await ensureMonth(db, CO, '2026-07')).id).toBe(jul.id);
    await expect(createPeriod(db, CO, { startsOn: '2026-07-15', endsOn: '2026-08-10' })).rejects.toMatchObject({ code: 'invalid', message: expect.stringContaining('overlaps') });
    await expect(createPeriod(db, CO, { startsOn: '2026-09-31', endsOn: '2026-10-01' })).rejects.toMatchObject({ code: 'invalid' });
    await ensureMonth(db, CO, '2026-08');
    expect((await listPeriods(db, CO)).map((p) => p.startsOn)).toEqual(['2026-07-01', '2026-08-01']);
  });

  it('AC6: closing a period rejects a transaction dated inside it, naming the period', async () => {
    const jul = (await listPeriods(db, CO))[0]!;
    const closed = await closePeriod(db, CO, jul.id, 'tester');
    expect(closed.status).toBe('closed');
    expect(closed.closedBy).toBe('tester');
    await expect(fund(1n, '2026-07-31T23:00:00Z', 'late')).rejects.toMatchObject({ code: 'period_closed', message: 'period 2026-07-01..2026-07-31 is closed' });
    // the day after is fine
    expect((await fund(1n, '2026-08-01T00:00:00Z', 'aug-1')).inserted).toBe(true);
    // closing twice is a no-op
    expect((await closePeriod(db, CO, jul.id)).status).toBe('closed');
  });
});

describe('M4 · profit and loss', () => {
  it('reports July: invoice income against two agents’ costs', async () => {
    const jul = (await listPeriods(db, CO))[0]!;
    const p = await profitAndLoss(db, CO, { from: `${jul.startsOn}T00:00:00Z`, to: `${jul.endsOn}T23:59:59.999Z` });
    expect(p.incomeMinor).toBe('90000');
    expect(p.expenseMinor).toBe('3000');
    expect(p.netMinor).toBe('87000');
    expect(p.lines.map((l) => [l.code, l.amountMinor])).toEqual([['4000', '90000'], ['5000', '3000']]);
    expect(p.groups).toEqual([]);
  });

  it('groups by agent', async () => {
    const p = await profitAndLoss(db, CO, { from: '2026-07-01T00:00:00Z', to: '2026-08-31T23:59:59Z' }, 'agent');
    const byKey = Object.fromEntries(p.groups.map((g) => [g.key, g]));
    expect(byKey[AGENT_A]!.expenseMinor).toBe('5000');
    expect(byKey[AGENT_A]!.incomeMinor).toBe('90000');
    expect(byKey[AGENT_B]!.expenseMinor).toBe('2000');
    expect(byKey[AGENT_B]!.incomeMinor).toBe('0');
    expect(p.expenseMinor).toBe('7000');
    expect(p.netMinor).toBe('83000');
  });

  it('August has the payment but no income (accrual), and the cost', async () => {
    const p = await profitAndLoss(db, CO, { from: '2026-08-01T00:00:00Z', to: '2026-08-31T23:59:59Z' });
    expect(p.incomeMinor).toBe('0');
    expect(p.expenseMinor).toBe('4000');
  });

  it('refuses a backwards window or a bad group', async () => {
    await expect(profitAndLoss(db, CO, { from: '2026-08-01T00:00:00Z', to: '2026-07-01T00:00:00Z' })).rejects.toMatchObject({ code: 'invalid' });
    await expect(profitAndLoss(db, CO, { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' }, 'nope' as never)).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('M4 · balance sheet', () => {
  it('AC7: balances at every date asked for', async () => {
    for (const at of ['2026-06-30T00:00:00Z', '2026-07-01T00:00:00Z', '2026-07-15T00:00:00Z', '2026-07-26T00:00:00Z', '2026-08-10T00:00:00Z', '2026-08-31T00:00:00Z', new Date().toISOString()]) {
      const bs = await balanceSheet(db, CO, at);
      expect(bs.balances, at).toBe(true);
      expect(bs.differenceMinor).toBe('0');
    }
  });

  it('shows the receivable before payment and treasury after', async () => {
    const before = await balanceSheet(db, CO, '2026-07-31T00:00:00Z');
    const rec = before.assets.lines.find((l) => l.code === '1100')!;
    expect(rec.balanceMinor).toBe('90000');
    expect(before.assets.totalMinor).toBe(String(500_000 - 3_000 + 90_000));
    expect(before.equity.retainedEarningsMinor).toBe('87000');
    expect(before.equity.totalMinor).toBe(String(500_000 + 87_000));

    const after = await balanceSheet(db, CO, '2026-08-31T00:00:00Z');
    expect(after.assets.lines.find((l) => l.code === '1100')!.balanceMinor).toBe('0');
    expect(after.assets.lines.find((l) => l.code === '1000')!.balanceMinor).toBe(String(500_000 - 7_000 + 90_000 + 1));
    expect(after.equity.retainedEarningsMinor).toBe('83000');
  });

  it('an empty company balances at zero', async () => {
    const EMPTY = '99999999-9999-4999-8999-999999999999';
    await seedAccounts(db, EMPTY, 'USD', { version: 1 });
    const bs = await balanceSheet(db, EMPTY);
    expect(bs.balances).toBe(true);
    expect(bs.assets.totalMinor).toBe('0');
  });
});
