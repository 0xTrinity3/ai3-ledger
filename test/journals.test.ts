/**
 * Journals, trial balance and drill-down. Under the plugin rules (statements
 * mode, host validators), like everything since M2.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT,
  balanceOf,
  createJournal,
  deleteJournal,
  getJournal,
  getTransaction,
  journalForTransaction,
  listEntries,
  listJournals,
  postJournal,
  postTransaction,
  profitAndLoss,
  seedAccounts,
  trialBalanceReport,
  updateJournal,
  voidJournal,
} from '../src/core/index.js';

const CO = '99999999-9999-4999-8999-999999999999';
const AGENT = 'a1a1a1a1-a1a1-4a1a-8a1a-a1a1a1a1a1a1';

let db: PluginTestDb;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  await postTransaction(db, {
    companyId: CO, occurredAt: '2026-08-01T00:00:00Z', sourcePlatform: 'manual', sourceKind: 'funding', sourceRef: 'fund-1', currency: 'USD', description: 'Funding',
    entries: [
      { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100_000n },
      { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 100_000n },
    ],
  });
});

afterAll(async () => {
  await db.close();
});

describe('journals', () => {
  it('numbers drafts, keeps them out of the books, and posts them on request', async () => {
    const j = await createJournal(db, CO, {
      occurredAt: '2026-08-10T00:00:00Z',
      narration: 'Accrue August hosting',
      lines: [
        { accountCode: ACCOUNT.COMPUTE_AND_SANDBOXES, direction: 'debit', amountMinor: 4_500n, subject: { agent: AGENT } },
        { accountCode: ACCOUNT.PAYABLES, direction: 'credit', amountMinor: 4_500n },
      ],
    });
    expect(j.number).toBe('JNL-0001');
    expect(j.status).toBe('draft');
    expect(j.debitMinor).toBe('4500');
    expect(await balanceOf(db, CO, ACCOUNT.PAYABLES)).toBe(0n);

    const posted = await postJournal(db, CO, j.id, { createdBy: 'tester' });
    expect(posted.status).toBe('posted');
    expect(posted.transactionId).toBeTruthy();
    expect(await balanceOf(db, CO, ACCOUNT.PAYABLES)).toBe(4_500n);
    expect(await balanceOf(db, CO, ACCOUNT.COMPUTE_AND_SANDBOXES)).toBe(4_500n);
    // posting twice is a no-op
    expect((await postJournal(db, CO, j.id)).transactionId).toBe(posted.transactionId);
    const back = await journalForTransaction(db, CO, posted.transactionId!);
    expect(back?.number).toBe('JNL-0001');
    const tx = await getTransaction(db, CO, posted.transactionId!);
    expect(tx?.sourceKind).toBe('journal');
    expect(tx?.entries.length).toBe(2);
  });

  it('refuses an unbalanced journal, a one-line journal and an unknown account', async () => {
    await expect(createJournal(db, CO, { occurredAt: '2026-08-10T00:00:00Z', lines: [
      { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 1n },
      { accountCode: ACCOUNT.PAYABLES, direction: 'credit', amountMinor: 2n },
    ] })).rejects.toThrow(/does not balance/);
    await expect(createJournal(db, CO, { occurredAt: '2026-08-10T00:00:00Z', lines: [{ accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 1n }] })).rejects.toThrow(/at least two/);
    await expect(createJournal(db, CO, { occurredAt: '2026-08-10T00:00:00Z', lines: [
      { accountCode: '7777', direction: 'debit', amountMinor: 1n },
      { accountCode: ACCOUNT.PAYABLES, direction: 'credit', amountMinor: 1n },
    ] })).rejects.toThrow(/unknown account/);
    expect((await listJournals(db, CO)).length).toBe(1);
  });

  it('edits and deletes a draft, but never a posted journal', async () => {
    const d = await createJournal(db, CO, { occurredAt: '2026-08-11T00:00:00Z', narration: 'wrong', lines: [
      { accountCode: ACCOUNT.OTHER_OPERATING, direction: 'debit', amountMinor: 100n },
      { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 100n },
    ] });
    const e = await updateJournal(db, CO, d.id, { narration: 'right', lines: [
      { accountCode: ACCOUNT.OTHER_OPERATING, direction: 'debit', amountMinor: 250n },
      { accountCode: ACCOUNT.TREASURY, direction: 'credit', amountMinor: 250n },
    ] });
    expect(e.narration).toBe('right');
    expect(e.debitMinor).toBe('250');
    expect((await deleteJournal(db, CO, d.id)).deleted).toBe(true);
    expect(await getJournal(db, CO, d.id)).toBeNull();
    const posted = (await listJournals(db, CO, { status: 'posted' }))[0]!;
    await expect(deleteJournal(db, CO, posted.id)).rejects.toThrow(/void it instead/);
    await expect(updateJournal(db, CO, posted.id, { narration: 'x' })).rejects.toThrow(/only a draft/);
  });

  it('voids a posted journal with a reversal, so reports net to nothing and the record stays', async () => {
    const j = (await listJournals(db, CO, { status: 'posted' }))[0]!;
    const v = await voidJournal(db, CO, j.id, { createdBy: 'tester', reason: 'accrued twice' });
    expect(v.status).toBe('voided');
    expect(v.reversalId).toBeTruthy();
    expect(await balanceOf(db, CO, ACCOUNT.PAYABLES)).toBe(0n);
    const tx = await getTransaction(db, CO, j.transactionId!);
    expect(tx?.reversedBy).toBe(v.reversalId);
    const rev = await getTransaction(db, CO, v.reversalId!);
    expect(rev?.reversesId).toBe(j.transactionId);
    expect((await journalForTransaction(db, CO, v.reversalId!))?.id).toBe(j.id);
    // the P&L for August shows the expense and its reversal cancelling
    const pnl = await profitAndLoss(db, CO, { from: '2026-08-01T00:00:00Z', to: '2026-08-31T23:59:59Z' });
    expect(pnl.expenseMinor).toBe('0');
    expect(await voidJournal(db, CO, j.id)).toMatchObject({ status: 'voided' });
  });

  it('posts in one call with post: true', async () => {
    const j = await createJournal(db, CO, { occurredAt: '2026-08-20T00:00:00Z', narration: 'Owner paid a tool', post: true, createdBy: 'tester', lines: [
      { accountCode: ACCOUNT.TOOLS_AND_APIS, direction: 'debit', amountMinor: 1_999n },
      { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 1_999n },
    ] });
    expect(j.status).toBe('posted');
    expect(j.number).toBe('JNL-0002'); // the deleted draft freed its number
  });
});

describe('trial balance', () => {
  it('lists every account with a balance on one side and agrees', async () => {
    const tb = await trialBalanceReport(db, CO, '2026-08-31T23:59:59Z');
    expect(tb.balances).toBe(true);
    expect(tb.debitMinor).toBe(tb.creditMinor);
    const treasury = tb.lines.find((l) => l.code === ACCOUNT.TREASURY)!;
    expect(treasury.debitMinor).toBe('100000');
    expect(treasury.creditMinor).toBe('0');
    const funds = tb.lines.find((l) => l.code === ACCOUNT.CONTRIBUTED_FUNDS)!;
    expect(funds.creditMinor).toBe('101999');
    expect(tb.lines.find((l) => l.code === ACCOUNT.PAYABLES)).toBeUndefined(); // voided journal nets to zero
    expect(tb.lines.map((l) => l.code)).toEqual([...tb.lines.map((l) => l.code)].sort());
  });

  it('limits to a window when asked', async () => {
    const tb = await trialBalanceReport(db, CO, '2026-08-31T23:59:59Z', '2026-08-15T00:00:00Z');
    expect(tb.lines.find((l) => l.code === ACCOUNT.TREASURY)).toBeUndefined();
    expect(tb.lines.find((l) => l.code === ACCOUNT.TOOLS_AND_APIS)?.debitMinor).toBe('1999');
  });
});

describe('drill-down', () => {
  it('returns the entries behind one account over a window with a running balance', async () => {
    const list = await listEntries(db, CO, { accountCode: ACCOUNT.COMPUTE_AND_SANDBOXES, from: '2026-08-01T00:00:00Z', to: '2026-08-31T23:59:59Z' });
    expect(list.rows.length).toBe(2);
    expect(list.rows[0]!.signedMinor).toBe('4500');
    expect(list.rows[1]!.signedMinor).toBe('-4500');
    expect(list.rows[1]!.runningMinor).toBe('0');
    expect(list.totalMinor).toBe('0');
    expect(list.rows[1]!.sourceKind).toBe('reversal');
  });

  it('filters by type, by subject and by source kind', async () => {
    const expenses = await listEntries(db, CO, { accountType: 'expense' });
    expect(expenses.rows.length).toBe(3);
    const byAgent = await listEntries(db, CO, { accountType: 'expense', groupBy: 'agent', groupKey: AGENT });
    expect(byAgent.rows.length).toBe(2);
    const unattributed = await listEntries(db, CO, { accountType: 'expense', groupBy: 'agent', groupKey: null });
    expect(unattributed.rows.length).toBe(1);
    const journals = await listEntries(db, CO, { sourceKind: 'journal' });
    expect(journals.rows.every((r) => r.sourceKind === 'journal')).toBe(true);
    expect(journals.rows.length).toBe(4);
  });

  it('says when the list was cut short', async () => {
    const list = await listEntries(db, CO, { limit: 2 });
    expect(list.rows.length).toBe(2);
    expect(list.truncated).toBe(true);
  });
});
