/**
 * Model credits: what ai3.co reports is booked into the books once, grants as
 * money put in, usage as the difference between charged-to-date and what the
 * ledger already carries, pathUSD top-ups left to the wallet feed. ai3.co is
 * a recorded response here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { ACCOUNT, accountBalances, balanceOf, createBankAccount, importStatementLines, listStatementLines, seedAccounts, updateSettings, getSettings, sumPostedBySource, profitAndLoss } from '../src/core/index.js';
import { syncCredits, fetchCredits, CREDITS_PLATFORM } from '../src/plugin/credits.js';
import { TOOL_DECLARATIONS } from '../src/plugin/tools.js';

const CO = '88888888-8888-4888-8888-888888888888';

let db: PluginTestDb;
beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
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
    expect(await balanceOf(db, CO, '1300')).toBe(20019n); // 500 + 20000 - 481
    expect(await balanceOf(db, CO, '5000')).toBe(481n);
    expect(await balanceOf(db, CO, '3000')).toBe(20500n); // equity, on its normal side

    const r2 = await syncCredits(db, ai3(HOSTED), settings, CO, 'test');
    expect(r2).toMatchObject({ grantsBooked: 0, usageBookedMinor: '0' });
    expect(await balanceOf(db, CO, '1300')).toBe(20019n);

    // More usage since: only the difference is posted.
    const later = { ...HOSTED, usageMinor: '1000', chargedMinor: '1200', remainingMinor: '19300' };
    const r3 = await syncCredits(db, ai3(later), settings, CO, 'test');
    expect(r3.usageBookedMinor).toBe('719');
    expect(await sumPostedBySource(db, CO, CREDITS_PLATFORM, 'cost_sweep', '5000', 'debit')).toBe(1200n);
    expect(await balanceOf(db, CO, '1300')).toBe(19300n);
  });

  it('leaves pathUSD top-ups to the wallet feed and books nothing for a company on its own key', async () => {
    const settings = await getSettings(db, CO, 'USD');
    const withCrypto = { ...HOSTED, chargedMinor: '1200', entries: [...HOSTED.entries, { at: '2026-09-12T09:00:00.000Z', amountMinor: '2000', kind: 'crypto', ref: 'line:abc' }] };
    const r = await syncCredits(db, ai3(withCrypto), settings, CO, 'test');
    expect(r.grantsBooked).toBe(0);
    expect(await balanceOf(db, CO, '1300')).toBe(19300n);
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

describe('a charge nobody priced still lands on the agents that caused it', () => {
  const CO2 = '44444444-4444-4444-4444-444444444444';
  const BUSY = '11111111-1111-4111-8111-111111111111';
  const QUIET = '22222222-2222-4222-8222-222222222222';

  it('splits the metered charge by measured tokens, and the parts sum to the whole', async () => {
    const db2 = await openPluginTestDb();
    await seedAccounts(db2, CO2, 'USD', { version: 1 });
    await updateSettings(db2, CO2, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });

    // Paperclip's own record of two agents at work. cost_cents is 0 on every
    // row: these ran through a CLI adapter, so the host priced none of them.
    const at = new Date().toISOString();
    for (const [agent, model, input, output] of [
      [BUSY, 'anthropic/claude-opus-4.1', 100_000, 20_000],
      [QUIET, 'anthropic/claude-haiku-4.5', 50_000, 5_000],
    ] as Array<[string, string, number, number]>) {
      await db2.raw.query(
        `INSERT INTO public.cost_events (company_id, agent_id, provider, biller, billing_type, cost_status, model, input_tokens, cached_input_tokens, output_tokens, cost_cents, occurred_at)
         VALUES ($1::uuid, $2::uuid, 'openrouter', 'openrouter', 'subscription', 'reported', $3, $4, 0, $5, 0, $6::timestamptz)`,
        [CO2, agent, model, input, output, at],
      );
    }

    // ai3.co says the provisioned key metered $12.34. That is the real money.
    const view = { ...HOSTED, chargedMinor: '1234', usageMinor: '1028', entries: [] };
    const r = await syncCredits(db2, ai3(view), await getSettings(db2, CO2, 'USD'), CO2, 'test');
    expect(r.usageBookedMinor).toBe('1234');
    expect(r.attributedToAgents).toBe(2);
    expect(r.unattributedMinor).toBe('0');

    // The books carry exactly what was metered, and every penny sits on an agent.
    const total = await sumPostedBySource(db2, CO2, CREDITS_PLATFORM, 'cost_sweep', ACCOUNT.MODEL_INFERENCE, 'debit');
    expect(total).toBe(1234n);

    const pnl = await profitAndLoss(db2, CO2, { from: '2000-01-01', to: '2100-01-01' }, 'agent');
    const perAgent = pnl.groups.filter((g) => g.key !== null);
    expect(perAgent.map((g) => g.key).sort()).toEqual([BUSY, QUIET].sort());
    const summed = perAgent.reduce((n, g) => n + BigInt(g.expenseMinor), 0n);
    expect(summed).toBe(1234n);

    // Opus output against haiku input: the busy agent carries far more of it.
    const busy = perAgent.find((g) => g.key === BUSY)!;
    const quiet = perAgent.find((g) => g.key === QUIET)!;
    expect(BigInt(busy.expenseMinor)).toBeGreaterThan(BigInt(quiet.expenseMinor) * 5n);
    await db2.close();
  });

  it('books the charge whole when no agent caused any of it', async () => {
    const CO3 = '33333333-3333-4333-8333-333333333333';
    const db3 = await openPluginTestDb();
    await seedAccounts(db3, CO3, 'USD', { version: 1 });
    await updateSettings(db3, CO3, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
    const r = await syncCredits(db3, ai3({ ...HOSTED, chargedMinor: '500', entries: [] }), await getSettings(db3, CO3, 'USD'), CO3, 'test');
    expect(r.usageBookedMinor).toBe('500');
    expect(r.attributedToAgents).toBe(0);
    expect(r.unattributedMinor).toBe('500');
    // Real money, still booked: the company is out of pocket either way.
    expect(await sumPostedBySource(db3, CO3, CREDITS_PLATFORM, 'cost_sweep', '5000', 'debit')).toBe(500n);
    await db3.close();
  });
});
