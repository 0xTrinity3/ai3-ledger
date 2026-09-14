import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTestDb, type TestDb } from './harness.js';
import {
  ACCOUNT,
  LedgerError,
  SEED_ACCOUNTS,
  accountBalances,
  balanceOf,
  postReversal,
  postTransaction,
  seedAccounts,
  trialBalance,
  validatePost,
  expenseAccountFor, CHARTS} from '../src/core/index.js';

const CO = 'company-a';
const OTHER = 'company-b';

let db: TestDb;

beforeAll(async () => {
  db = await openTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  await seedAccounts(db, OTHER, 'USD', { version: 1 });
});

afterAll(async () => {
  await db.close();
});

describe('M1 · chart of accounts', () => {
  it('seeds one chart once and is idempotent', async () => {
    const again = await seedAccounts(db, CO, 'USD', { version: 1 });
    expect(again).toBe(0);
    const rows = await accountBalances(db, CO);
    // These books were opened on chart 1 and stay on it: seeding again is not
    // a chance to renumber a company that already has postings.
    expect(rows.map((r) => r.code)).toEqual(CHARTS[1].accounts.map((a) => a.code));
    expect(rows.every((r) => r.balanceMinor === 0n)).toBe(true);
  });
});

describe('M1 · posting', () => {
  it('rejects an unbalanced transaction in code before touching the database', () => {
    expect(() =>
      validatePost({
        companyId: CO,
        occurredAt: new Date(),
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        currency: 'USD',
        entries: [
          { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100n },
          { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 99n },
        ],
      }),
    ).toThrowError(LedgerError);
  });

  it('rejects a single-entry transaction', () => {
    expect(() =>
      validatePost({
        companyId: CO,
        occurredAt: new Date(),
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        currency: 'USD',
        entries: [{ accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100n }],
      }),
    ).toThrowError(/at least two/);
  });

  it('rejects a zero or negative amount', () => {
    expect(() =>
      validatePost({
        companyId: CO,
        occurredAt: new Date(),
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        currency: 'USD',
        entries: [
          { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 0n },
          { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 0n },
        ],
      }),
    ).toThrowError(/positive/);
  });

  it('posts a funding transaction atomically and reads the balances back', async () => {
    const r = await postTransaction(db, {
      companyId: CO,
      occurredAt: '2026-09-01T10:00:00Z',
      description: 'Founder funding',
      sourcePlatform: 'manual',
      sourceKind: 'funding',
      sourceRef: 'fund-1',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 500_00n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 500_00n },
      ],
    });
    expect(r.ok).toBe(true);
    expect(r.inserted).toBe(true);
    expect(await balanceOf(db, CO, '1000')).toBe(500_00n);
    expect(await balanceOf(db, CO, '3000')).toBe(500_00n);
  });

  it('is idempotent on source ref: a replay writes nothing and returns the original id', async () => {
    const first = await postTransaction(db, {
      companyId: CO,
      occurredAt: '2026-09-02T10:00:00Z',
      sourcePlatform: 'paperclip',
      sourceKind: 'cost_sweep',
      sourceRef: 'cost-evt-1',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.MODEL_INFERENCE, direction: 'debit', amountMinor: 12_34n, subject: { agent: 'agent-1' } },
        { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 12_34n, subject: { agent: 'agent-1' } },
      ],
    });
    const before = await trialBalance(db, CO);
    const replay = await postTransaction(db, {
      companyId: CO,
      occurredAt: '2026-09-02T10:00:00Z',
      sourcePlatform: 'paperclip',
      sourceKind: 'cost_sweep',
      sourceRef: 'cost-evt-1',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.MODEL_INFERENCE, direction: 'debit', amountMinor: 12_34n },
        { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 12_34n },
      ],
    });
    const after = await trialBalance(db, CO);
    expect(replay.inserted).toBe(false);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(after.entryCount).toBe(before.entryCount);
  });

  it('the database itself refuses an unbalanced insert even when code is bypassed', async () => {
    await expect(
      db.sql.query(
        `SELECT * FROM ledger_post($1, now(), '', 'manual', 'manual', NULL, 'test', NULL, 'USD', $2::jsonb)`,
        [
          CO,
          JSON.stringify([
            // Straight to the function: no resolution happens here, so these
            // are this company's own codes rather than roles.
            { code: '1000', direction: 'debit', amount: '100' },
            { code: '3000', direction: 'credit', amount: '90' },
          ]),
        ],
      ),
    ).rejects.toThrowError(/does not balance/);
    const tb = await trialBalance(db, CO);
    expect(tb.netMinor).toBe(0n);
  });

  it('an unknown account code fails the whole posting, leaving nothing behind', async () => {
    const before = await trialBalance(db, CO);
    await expect(
      postTransaction(db, {
        companyId: CO,
        occurredAt: new Date(),
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        currency: 'USD',
        entries: [
          { accountCode: '9999', direction: 'debit', amountMinor: 5n },
          { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 5n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'unknown_account' });
    const after = await trialBalance(db, CO);
    expect(after.entryCount).toBe(before.entryCount);
  });
});

describe('M1 · invariants', () => {
  it('criterion 4: the trial balance sums to zero at every point', async () => {
    for (let i = 0; i < 5; i++) {
      await postTransaction(db, {
        companyId: CO,
        occurredAt: new Date(Date.UTC(2026, 8, 3 + i)),
        sourcePlatform: 'paperclip',
        sourceKind: 'cost_sweep',
        sourceRef: `cost-loop-${i}`,
        currency: 'USD',
        entries: [
          { accountCode: expenseAccountFor(i % 2 ? 'tool' : 'model'), direction: 'debit', amountMinor: BigInt(100 + i) },
          { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: BigInt(100 + i) },
        ],
      });
      const tb = await trialBalance(db, CO);
      expect(tb.netMinor).toBe(0n);
    }
  });

  it('the ledger is append-only: updates and deletes are refused by the database', async () => {
    await expect(db.sql.execute(`UPDATE entries SET amount_minor = amount_minor + 1`)).rejects.toThrowError(/not allowed/);
    await expect(db.sql.execute(`DELETE FROM transactions`)).rejects.toThrowError(/not allowed/);
    await expect(db.sql.execute(`DELETE FROM entries`)).rejects.toThrowError(/not allowed/);
  });

  it('a reversal is the exact mirror and nets the original to zero', async () => {
    const original = await postTransaction(db, {
      companyId: CO,
      occurredAt: '2026-09-10T09:00:00Z',
      description: 'Mistaken charge',
      sourcePlatform: 'manual',
      sourceKind: 'manual',
      sourceRef: 'oops-1',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.OTHER_OPERATING, direction: 'debit', amountMinor: 77n, subject: { project: 'p1' } },
        { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 77n, subject: { project: 'p1' } },
      ],
    });
    const otherBefore = await balanceOf(db, CO, ACCOUNT.OTHER_OPERATING);
    const rev = await postReversal(db, CO, original.transactionId);
    expect(rev.inserted).toBe(true);
    expect(await balanceOf(db, CO, '5900')).toBe(otherBefore - 77n);
    // Reversing twice is a no-op thanks to the deterministic source ref.
    const again = await postReversal(db, CO, original.transactionId);
    expect(again.inserted).toBe(false);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
  });

  it('as-of balances only count transactions up to the moment asked for', async () => {
    const early = await balanceOf(db, CO, ACCOUNT.TREASURY, '2026-09-01T23:59:59Z');
    const late = await balanceOf(db, CO, ACCOUNT.TREASURY);
    expect(early).toBe(500_00n);
    expect(late).toBeLessThan(early);
  });

  it('a closed period refuses a new transaction dated inside it, naming the period', async () => {
    await db.sql.execute(
      `INSERT INTO periods (company_id, starts_on, ends_on, status, closed_at, closed_by)
       VALUES ($1, '2026-08-01', '2026-08-31', 'closed', now(), 'test')`,
      [CO],
    );
    await expect(
      postTransaction(db, {
        companyId: CO,
        occurredAt: '2026-08-15T12:00:00Z',
        sourcePlatform: 'manual',
        sourceKind: 'manual',
        currency: 'USD',
        entries: [
          { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 1n },
          { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 1n },
        ],
      }),
    ).rejects.toMatchObject({ code: 'period_closed', message: expect.stringMatching(/2026-08-01\.\.2026-08-31/) });
  });
});

describe('M1 · tenancy', () => {
  it('criterion 10: one company never sees another company’s entries', async () => {
    await postTransaction(db, {
      companyId: OTHER,
      occurredAt: new Date(),
      sourcePlatform: 'manual',
      sourceKind: 'funding',
      sourceRef: 'b-fund',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 9_99n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 9_99n },
      ],
    });
    expect(await balanceOf(db, OTHER, '1000')).toBe(9_99n);
    const a = await accountBalances(db, CO);
    const treasuryA = a.find((x) => x.code === '1000')!;
    expect(treasuryA.balanceMinor).not.toBe(9_99n);
    // The same source ref in a different company is a different transaction: uniqueness is per company.
    const r = await postTransaction(db, {
      companyId: CO,
      occurredAt: new Date(),
      sourcePlatform: 'manual',
      sourceKind: 'funding',
      sourceRef: 'b-fund',
      currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 1n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 1n },
      ],
    });
    expect(r.inserted).toBe(true);
    expect(await balanceOf(db, OTHER, '1000')).toBe(9_99n);
  });
});

describe('M1 · boundary', () => {
  it('criterion 11: the core imports nothing from any platform', async () => {
    const coreDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core');
    const files = (await readdir(coreDir)).filter((f) => f.endsWith('.ts'));
    for (const f of files) {
      const text = await readFile(path.join(coreDir, f), 'utf8');
      expect(text, `${f} imports a platform package`).not.toMatch(/from ['"]@paperclipai\//);
      expect(text, `${f} reaches outside core`).not.toMatch(/from ['"]\.\.\//);
    }
  });
});
