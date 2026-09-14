// Two charts of accounts, at once.
//
// The core used to post to hard-coded numbers: receivables *were* 1100. That
// made the default chart unchangeable — changing it would have silently
// repointed every future posting of every existing company at whatever else
// now sat on that number, in an append-only ledger that cannot be renumbered.
//
// So the core posts to roles, and a role becomes a code when a company is
// asked which one it means.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT, CHARTS, CURRENT_CHART, accountBalances, accountsOf, balanceOf, chartVersionOf, codeFor,
  createCustomer, createInvoice, isRole, issueInvoice, postTransaction, rolesOf, seedAccounts,
} from '../src/core/index.js';

let db: PluginTestDb;
let n = 0;
const fresh = () => `abcd${String(n += 1).padStart(4, '0')}-1111-4111-8111-111111111111`;

beforeAll(async () => { db = await openPluginTestDb(); });
afterAll(async () => { await db.close(); });

describe('charts', () => {
  it('a company opened today gets the current chart, and says so', async () => {
    const CO = fresh();
    const added = await seedAccounts(db, CO, 'USD');
    expect(added).toBe(CHARTS[CURRENT_CHART].accounts.length);
    expect(await chartVersionOf(db, CO)).toBe(CURRENT_CHART);

    const codes = (await accountBalances(db, CO)).map((a) => a.code);
    // The shape of the chart somebody asked for: groups of ten within
    // thousands, and the lines an agent business actually has.
    expect(codes).toContain('1110'); // agent-controlled balances
    expect(codes).toContain('5100'); // production model inference
    expect(codes).toContain('6400'); // agent mistakes and remediation
    expect(codes).toContain('4200'); // marketplace commissions
    // And nothing posts to a group header.
    expect(codes).not.toContain('1000');
    expect(codes).not.toContain('5000');
  });

  it('roles resolve to that chart, and a posting lands on the right account', async () => {
    const CO = fresh();
    await seedAccounts(db, CO, 'USD');
    await postTransaction(db, {
      companyId: CO, occurredAt: new Date('2026-09-14'), description: 'Opening', sourceKind: 'journal',
      sourcePlatform: 'manual', currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100_000n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 100_000n },
      ],
    });
    // 1100 Operating bank accounts and 3100 Share capital, not 1000 and 3000.
    expect(await balanceOf(db, CO, '1100')).toBe(100_000n);
    expect(await balanceOf(db, CO, '3100')).toBe(100_000n);
    // And asking by role gets the same answer without knowing the number.
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(100_000n);
  });

  it('a company on the old chart keeps posting to the old numbers', async () => {
    const CO = fresh();
    await seedAccounts(db, CO, 'USD', { version: 1 });
    expect(await chartVersionOf(db, CO)).toBe(1);
    await postTransaction(db, {
      companyId: CO, occurredAt: new Date('2026-09-14'), description: 'Opening', sourceKind: 'journal',
      sourcePlatform: 'manual', currency: 'USD',
      entries: [
        { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 5_000n },
        { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 5_000n },
      ],
    });
    expect(await balanceOf(db, CO, '1000')).toBe(5_000n);
    expect(await balanceOf(db, CO, '3000')).toBe(5_000n);
  });

  it('seeding again never renumbers a company that already has a chart', async () => {
    const CO = fresh();
    await seedAccounts(db, CO, 'USD', { version: 1 });
    // openCompanyBooks calls this on every open; the current default must not
    // pour sixty accounts into books that have been using fourteen.
    const added = await seedAccounts(db, CO, 'USD');
    expect(added).toBe(0);
    expect(await chartVersionOf(db, CO)).toBe(1);
    expect((await accountBalances(db, CO)).length).toBe(CHARTS[1].accounts.length);
  });

  it('every role has an account in every chart', () => {
    for (const version of [1, 2] as const) {
      const codes = new Set(CHARTS[version].accounts.map((a) => a.code));
      for (const role of Object.values(ACCOUNT)) {
        const code = codeFor(role, version);
        expect(isRole(code)).toBe(false);
        expect(codes.has(code), `${role} → ${code} is missing from chart ${version}`).toBe(true);
      }
    }
  });

  it('an invoice raised on the new chart books revenue and receivables where the chart puts them', async () => {
    const CO = fresh();
    await seedAccounts(db, CO, 'USD');
    const c = await createCustomer(db, CO, { name: 'Bluefin' });
    const draft = await createInvoice(db, CO, {
      customerId: c.id, currency: 'USD',
      lines: [{ description: 'Agent work', quantity: '1', unitAmountMinor: '25000' }],
    });
    await issueInvoice(db, CO, draft.id, { by: 'test' });
    expect(await balanceOf(db, CO, '1200')).toBe(25_000n); // Accounts receivable
    expect(await balanceOf(db, CO, '4130')).toBe(25_000n); // Managed agent services
  });

  it('the role map is the same object the rest of the core reads', async () => {
    const CO = fresh();
    await seedAccounts(db, CO, 'USD');
    expect(await accountsOf(db, CO)).toEqual(rolesOf(CURRENT_CHART));
  });
});
