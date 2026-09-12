/**
 * The company summary and its publication to ai3.co: figures from posted
 * entries only, windows that do not overlap, opt-in that defaults to off and
 * travels with the payload, and a fake ai3.co that records what arrived.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { ACCOUNT, companySummary, createCustomer, createInvoice, getSettings, issueInvoice, postTransaction, recordPayment, seedAccounts, updateSettings } from '../src/core/index.js';
import { buildSummaryPayload, countTasks, publishSummary } from '../src/plugin/publish.js';
import { paperclipCostSource } from '../src/plugin/cost-source.js';
import { sweepCosts } from '../src/core/index.js';

const CO = '99999999-9999-4999-8999-999999999999';
const EMPTY = '99999999-9999-4999-8999-000000000000';
const AGENT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NOW = new Date('2026-09-12T12:00:00Z');
let db: PluginTestDb;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  await seedAccounts(db, EMPTY, 'USD');
  await postTransaction(db, {
    companyId: CO, occurredAt: '2026-07-01T00:00:00Z', sourcePlatform: 'manual', sourceKind: 'funding', sourceRef: 'fund', currency: 'USD', description: 'Funding',
    entries: [
      { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 300_000n },
      { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 300_000n },
    ],
  });
  // Model spend: 10.00 inside the trailing window, 5.00 in the window before it.
  await db.raw.query(
    `INSERT INTO public.cost_events (company_id, agent_id, provider, model, billing_type, cost_status, cost_cents, occurred_at, created_at)
     VALUES ($1, $2, 'anthropic', 'claude-sonnet-5', 'metered_api', 'reported', 1000, '2026-09-01T00:00:00Z', '2026-09-01T00:00:00Z'),
            ($1, $2, 'anthropic', 'claude-sonnet-5', 'metered_api', 'reported', 500, '2026-08-01T00:00:00Z', '2026-08-01T00:00:00Z')`,
    [CO, AGENT],
  );
  await sweepCosts(db, paperclipCostSource(db.sql), CO, { currency: 'USD' });
  const c = await createCustomer(db, CO, { name: 'Client' });
  const recent = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', dueAt: '2026-09-05T00:00:00Z', lines: [{ description: 'Work', unitAmountMinor: 100_000 }] });
  await issueInvoice(db, CO, recent.id, { issuedAt: '2026-08-20T00:00:00Z' });
  const older = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'Earlier work', unitAmountMinor: 40_000 }] });
  await issueInvoice(db, CO, older.id, { issuedAt: '2026-07-20T00:00:00Z' });
  await recordPayment(db, CO, older.id, { amountMinor: 40_000, occurredAt: '2026-08-25T00:00:00Z', reference: 'wire' });
});
afterAll(async () => { await db.close(); });

describe('company summary', () => {
  it('reads revenue, profit, model cost and cash from posted entries over the trailing 30 days', async () => {
    const s = await companySummary(db, CO, NOW);
    expect(s.currency).toBe('USD');
    expect(s.trailing30d.revenueMinor).toBe('100000');
    expect(s.trailing30d.modelCostMinor).toBe('1000');
    expect(s.trailing30d.agentCostMinor).toBe('1000');
    expect(s.trailing30d.profitMinor).toBe('99000');
    expect(s.trailing30d.invoicesIssued).toBe(1);
    expect(s.trailing30d.invoicesPaid).toBe(1);
    expect(s.prior30d.revenueMinor).toBe('40000');
    expect(s.prior30d.modelCostMinor).toBe('500');
    expect(s.treasuryMinor).toBe(String(300_000 - 1500 + 40_000));
    expect(s.receivablesMinor).toBe('100000');
    expect(s.overdue).toEqual({ count: 1, amountMinor: '100000' });
    expect(s.runwayDays).toBeGreaterThan(0);
    expect(s.customers).toBe(1);
    expect(s.entryCount).toBeGreaterThan(0);
    expect(s.lastPostedAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('is all zeros, not invented, for empty books', async () => {
    const s = await companySummary(db, EMPTY, NOW);
    expect(s.entryCount).toBe(0);
    expect(s.trailing30d.revenueMinor).toBe('0');
    expect(s.treasuryMinor).toBe('0');
    expect(s.runwayDays).toBeNull();
    expect(s.lastPostedAt).toBeNull();
  });

  it('counts finished tasks in the window and open ones now, nothing else', () => {
    const t = countTasks([
      { status: 'done', updatedAt: '2026-09-10T00:00:00Z' },
      { status: 'done', updatedAt: '2026-06-01T00:00:00Z' },
      { status: 'todo', updatedAt: '2026-09-10T00:00:00Z' },
      { status: 'cancelled', updatedAt: '2026-09-10T00:00:00Z' },
    ], NOW);
    expect(t).toEqual({ completed30d: 1, open: 1 });
  });
});

describe('publishing to ai3.co', () => {
  it('opt-in is off by default and the payload says so', async () => {
    const settings = await getSettings(db, CO);
    expect(settings.leaderboardOptIn).toBe(false);
    const p = await buildSummaryPayload(db, { companyId: CO, companyName: 'Co', settings, issues: null, now: NOW });
    expect(p.leaderboardOptIn).toBe(false);
    expect(p.tasks).toBeNull();
    expect(p.summary.trailing30d.revenueMinor).toBe('100000');
  });

  it('does nothing for a company that is not connected', async () => {
    const calls: string[] = [];
    const r = await publishSummary(db, async (url) => { calls.push(url); return new Response('{}'); }, { companyId: CO, companyName: 'Co', issues: null, now: NOW });
    expect(r.published).toBe(false);
    expect(calls).toEqual([]);
  });

  it('posts the payload with the company key, carries the opt-in, and records the moment', async () => {
    await updateSettings(db, CO, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test', leaderboardOptIn: true });
    const before = await getSettings(db, CO);
    expect(before.leaderboardOptIn).toBe(true);
    expect(before.leaderboardOptedAt).not.toBeNull();
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const r = await publishSummary(db, async (url, init) => { calls.push({ url, init }); return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } }); }, {
      companyId: CO, companyName: 'Co', issues: [{ status: 'done', updatedAt: '2026-09-11T00:00:00Z' }], now: NOW,
    });
    expect(r.published).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ai3.test/api/ledger/summary');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer ai3k_test');
    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(body.leaderboardOptIn).toBe(true);
    expect(body.tasks).toEqual({ completed30d: 1, open: 0 });
    expect(body.summary.companyId).toBe(CO);
    expect(JSON.stringify(body)).not.toMatch(/Client/); // no customer names travel
    expect((await getSettings(db, CO)).summaryPublishedAt).toBe(NOW.toISOString());
  });

  it('switching the opt-in off clears the opted-at moment and travels as false', async () => {
    await updateSettings(db, CO, { leaderboardOptIn: false });
    const s = await getSettings(db, CO);
    expect(s.leaderboardOptIn).toBe(false);
    expect(s.leaderboardOptedAt).toBeNull();
    const p = await buildSummaryPayload(db, { companyId: CO, companyName: 'Co', settings: s, issues: null, now: NOW });
    expect(p.leaderboardOptIn).toBe(false);
  });
});
