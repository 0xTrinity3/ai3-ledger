/**
 * Model credits: what ai3.co reports is booked into the books once, grants as
 * money put in, usage as the difference between charged-to-date and what the
 * ledger already carries, pathUSD top-ups left to the wallet feed. ai3.co is
 * a recorded response here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { ACCOUNT, accountBalances, balanceOf, createBankAccount, importStatementLines, listStatementLines, seedAccounts, updateSettings, getSettings, sumPostedBySource } from '../src/core/index.js';
import { syncCredits, fetchCredits, CREDITS_PLATFORM } from '../src/plugin/credits.js';
import { TOOL_DECLARATIONS } from '../src/plugin/tools.js';

const CO = '88888888-8888-4888-8888-888888888888';

let db: PluginTestDb;
beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  await updateSettings(db, CO, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
});
afterAll(async () => { await db.close(); });

function ai3(view: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    calls.push(url);
    expect(String((init?.headers as Record<string, string>)['authorization'])).toBe('Bearer ai3k_test');
    return new Response(JSON.stringify(view), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return Object.assign(fetch, { calls });
}

const HOSTED = {
  hosted: true, keyed: true, slug: 'test-1234', at: '2026-09-12T10:00:00.000Z', markup: 0.2, platformWallet: '0x3Bf06Af790E10ac39f0d07ECf68aefb8a7d6D354', memo: 'credit:test-1234',
  creditsUrl: 'https://ai3.test/companies/credits?id=abc', modelUrl: 'https://ai3.test/companies/model?id=abc',
  grantedMinor: '20500', usageMinor: '401', chargedMinor: '481', remainingMinor: '20019', usageMonthlyMinor: '401', keyDisabled: false,
  entries: [
    { at: '2026-09-11T17:07:00.000Z', amountMinor: '500', kind: 'free', ref: 'free:test-1234' },
    { at: '2026-09-11T17:54:00.000Z', amountMinor: '20000', kind: 'admin', ref: 'platform-company-2026-09' },
  ],
};

describe('model credits', () => {
  it('reads the view with the company key', async () => {
    const f = ai3(HOSTED);
    const v = await fetchCredits(f, await getSettings(db, CO, 'USD'), CO);
    expect(v).toMatchObject({ hosted: true, keyed: true, remainingMinor: '20019', memo: 'credit:test-1234' });
    expect(f.calls[0]).toBe('https://ai3.test/api/ledger/credits');
  });

  it('books grants into prepaid credits and usage out of it, once', async () => {
    const settings = await getSettings(db, CO, 'USD');
    const r1 = await syncCredits(db, ai3(HOSTED), settings, CO, 'test');
    expect(r1).toMatchObject({ fetched: true, grantsBooked: 2, usageBookedMinor: '481', skipped: null });
    expect(await balanceOf(db, CO, ACCOUNT.PREPAID_CREDITS)).toBe(20019n); // 500 + 20000 - 481
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(481n);
    expect(await balanceOf(db, CO, ACCOUNT.CONTRIBUTED_FUNDS)).toBe(20500n); // equity, on its normal side

    const r2 = await syncCredits(db, ai3(HOSTED), settings, CO, 'test');
    expect(r2).toMatchObject({ grantsBooked: 0, usageBookedMinor: '0' });
    expect(await balanceOf(db, CO, ACCOUNT.PREPAID_CREDITS)).toBe(20019n);

    // More usage since: only the difference is posted.
    const later = { ...HOSTED, usageMinor: '1000', chargedMinor: '1200', remainingMinor: '19300' };
    const r3 = await syncCredits(db, ai3(later), settings, CO, 'test');
    expect(r3.usageBookedMinor).toBe('719');
    expect(await sumPostedBySource(db, CO, CREDITS_PLATFORM, 'cost_sweep', ACCOUNT.MODEL_INFERENCE, 'debit')).toBe(1200n);
    expect(await balanceOf(db, CO, ACCOUNT.PREPAID_CREDITS)).toBe(19300n);
  });

  it('leaves pathUSD top-ups to the wallet feed and books nothing for a company on its own key', async () => {
    const settings = await getSettings(db, CO, 'USD');
    const withCrypto = { ...HOSTED, chargedMinor: '1200', entries: [...HOSTED.entries, { at: '2026-09-12T09:00:00.000Z', amountMinor: '2000', kind: 'crypto', ref: 'line:abc' }] };
    const r = await syncCredits(db, ai3(withCrypto), settings, CO, 'test');
    expect(r.grantsBooked).toBe(0);
    expect(await balanceOf(db, CO, ACCOUNT.PREPAID_CREDITS)).toBe(19300n);
    const own = await syncCredits(db, ai3({ ...HOSTED, keyed: false }), settings, CO, 'test');
    expect(own.skipped).toMatch(/own model key/);
    const notHosted = await syncCredits(db, ai3({ hosted: false, keyed: false, entries: [] }), settings, CO, 'test');
    expect(notHosted.skipped).toMatch(/not a hosted/);
  });

  it('seeds the prepaid credits account and declares the credits tool', async () => {
    const codes = (await accountBalances(db, CO)).map((a) => a.code);
    expect(codes).toContain('1300');
    expect(TOOL_DECLARATIONS.map((t) => t.name)).toContain('credits');
  });

  it('a wallet send with a credit memo is a top-up line for the matcher, not an expense', async () => {
    const bank = await createBankAccount(db, CO, { name: 'Tempo wallet', kind: 'wallet', currency: 'USD', feed: 'chain' });
    await importStatementLines(db, CO, bank.id, [{ postedAt: '2026-09-12T11:00:00.000Z', amountMinor: -2000n, description: 'pathUSD to 0x3Bf0… · credit:test-1234', payee: '0x3Bf06Af790E10ac39f0d07ECf68aefb8a7d6D354', reference: 'credit:test-1234', externalId: '0xtopup:0' }]);
    const line = (await listStatementLines(db, CO, bank.id))[0]!;
    expect(line.reference).toBe('credit:test-1234');
    expect(/^credit:[a-z0-9-]+$/i.test(line.reference ?? '')).toBe(true); // the rule the chain feed applies before the matcher guesses
  });
});
