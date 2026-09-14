/**
 * Marketplace billing: ai3.co says what is due, the company's own books carry
 * the invoice, and what has been collected goes back. ai3.co is a scripted
 * fetch here; the direction of control is the thing under test — nothing
 * reaches into the tenant.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { getInvoice, listInvoices, recordPayment, seedAccounts, updateSettings } from '../src/core/index.js';
import { runMarket, type DueItem, type OpenItem } from '../src/plugin/market.js';
import type { ToolDeps } from '../src/plugin/tools.js';
import manifest from '../src/manifest.js';

const CO = '77777777-7777-4777-7777-777777777777';

let db: PluginTestDb;
beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
});
afterAll(async () => { await db.close(); });

const DUE: DueItem = {
  ref: 'bill:x-agent:c-recourse:2026-08',
  period: '2026-08',
  periodFrom: '2026-08-01T00:00:00.000Z',
  periodTo: '2026-09-01T00:00:00.000Z',
  listing: { slug: 'x-agent', name: 'X Agent', version: 1 },
  buyer: { companyId: 'c-recourse', name: 'Recourse', email: 'joey@ai3.co' },
  currency: 'USD',
  lines: [
    { description: 'X agent, monthly', quantity: '1', amountMinor: '20000' },
    { description: 'Share of revenue growth — 5% of revenue growth', quantity: '1', amountMinor: '15000' },
  ],
  totalMinor: '35000',
  capped: true,
  notes: ["Reduced from $500.00 to the buyer's monthly cap of $350.00."],
  measuredOn: '2026-08-31T04:30:00.000Z',
};

/**
 * A recorded ai3.co. `due` and `open` are what it answers; every write is kept
 * so the test can assert what the plugin told it.
 */
function ai3(script: { due?: DueItem[]; open?: OpenItem[]; commission?: unknown[] } = {}) {
  const wrote: Array<{ path: string; body: Record<string, unknown> }> = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    const reply = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/api/market/billing/due') return reply({ due: script.due ?? [] });
    if (path === '/api/market/billing/open') return reply({ open: script.open ?? [] });
    if (path === '/api/market/commission/due') {
      if (!script.commission) return reply({ error: 'Only the platform company invoices commission' }, 403);
      return reply({ due: script.commission });
    }
    if (path === '/api/ledger/invoices') return reply({ token: `tok-${wrote.length}`, url: `https://ai3.test/i/tok-${wrote.length}` });
    wrote.push({ path, body });
    return reply({ ok: true });
  };
  return Object.assign(fetch, { wrote });
}

function deps(fetch: ToolDeps['fetch']): ToolDeps {
  return { db, fetch, companyName: async () => 'AI3 Developer', baseCurrency: 'USD' };
}

describe('marketplace billing', () => {
  it('is declared as a job that runs after the figures are published', () => {
    const job = manifest.jobs?.find((j) => j.jobKey === 'market');
    expect(job).toBeTruthy();
    expect(job!.schedule).toBe('0 5 * * *');
    const publish = manifest.jobs?.find((j) => j.jobKey === 'publish');
    expect(publish!.schedule).toBe('30 4 * * *');
  });

  it('does nothing at all for a company that is not connected', async () => {
    const f = ai3({ due: [DUE] });
    const r = await runMarket(deps(f), CO);
    expect(r).toMatchObject({ connected: false, skipped: 'not connected to ai3.co' });
    expect(f.wrote).toEqual([]);
    expect(await listInvoices(db, CO)).toHaveLength(0);
  });

  it('raises the invoice in its own books and reports the number back', async () => {
    await updateSettings(db, CO, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
    const f = ai3({ due: [DUE] });
    const r = await runMarket(deps(f), CO);
    expect(r.failures).toEqual([]);
    expect(r.invoiced).toHaveLength(1);
    expect(r.invoiced[0]).toMatchObject({ ref: DUE.ref, buyer: 'Recourse', total: '350.00' });

    const invoices = await listInvoices(db, CO);
    expect(invoices).toHaveLength(1);
    const inv = (await getInvoice(db, CO, invoices[0]!.id))!;
    expect(inv.status).toBe('issued');
    expect(inv.reference).toBe(DUE.ref);
    expect(inv.customerName).toBe('Recourse');
    expect(inv.totalMinor).toBe('35000');
    expect(inv.lines).toHaveLength(2);
    // The buyer can see the period, the figure it was measured on, why it was
    // reduced, and where a dispute goes.
    expect(inv.notes).toContain('2026-08');
    expect(inv.notes).toContain('2026-08-31');
    expect(inv.notes).toContain("monthly cap of $350.00");
    expect(inv.notes).toContain('Recourse under the Recourse Standard Rules v1.0');

    const issued = f.wrote.find((w) => w.path === '/api/market/billing/issued');
    expect(issued).toBeTruthy();
    expect(issued!.body).toMatchObject({ ref: DUE.ref, number: inv.number });
    expect(issued!.body['url']).toMatch(/^https:\/\/ai3\.test\/i\//);
  });

  it('does not raise the same month twice, and says so again if the report was lost', async () => {
    const f = ai3({ due: [DUE] });
    const r = await runMarket(deps(f), CO);
    expect(r.failures).toEqual([]);
    expect(await listInvoices(db, CO)).toHaveLength(1);
    // Reported again, so a failed report on the first pass is recoverable.
    expect(f.wrote.filter((w) => w.path === '/api/market/billing/issued')).toHaveLength(1);
  });

  it('reports only the money that has actually arrived since ai3.co last heard', async () => {
    const inv = (await listInvoices(db, CO))[0]!;
    const open: OpenItem = {
      ref: DUE.ref, number: inv.number, url: null, currency: 'USD',
      totalMinor: '35000', collectedMinor: '0', buyer: { companyId: 'c-recourse', name: 'Recourse' }, period: '2026-08',
    };
    // Nothing paid yet: nothing to report.
    let f = ai3({ open: [open] });
    expect((await runMarket(deps(f), CO)).collected).toEqual([]);
    expect(f.wrote.filter((w) => w.path === '/api/market/billing/paid')).toHaveLength(0);

    await recordPayment(db, CO, inv.id, { amountMinor: '10000', occurredAt: new Date('2026-09-10T00:00:00Z'), createdBy: 'test' });
    f = ai3({ open: [open] });
    let r = await runMarket(deps(f), CO);
    expect(r.collected).toEqual([{ ref: DUE.ref, number: inv.number, amount: '100.00' }]);
    expect(f.wrote.find((w) => w.path === '/api/market/billing/paid')!.body).toMatchObject({ ref: DUE.ref, amountMinor: '10000' });

    // ai3.co now knows about the first 100.00; only the rest is new.
    await recordPayment(db, CO, inv.id, { amountMinor: '25000', occurredAt: new Date('2026-09-11T00:00:00Z'), createdBy: 'test' });
    f = ai3({ open: [{ ...open, collectedMinor: '10000' }] });
    r = await runMarket(deps(f), CO);
    expect(r.collected[0]).toMatchObject({ amount: '250.00' });
    expect(f.wrote.find((w) => w.path === '/api/market/billing/paid')!.body).toMatchObject({ amountMinor: '25000' });
  });

  it('treats "you are not the platform" as an answer, not a failure', async () => {
    const f = ai3({});
    const r = await runMarket(deps(f), CO);
    expect(r.failures).toEqual([]);
    expect(r.commission).toEqual([]);
  });

  it('bills a developer their commission when this company is the platform', async () => {
    const f = ai3({
      commission: [{
        sellerCompanyId: 'c-dev', sellerName: 'Someone Else Ltd', currency: 'USD',
        refs: ['bill:x-agent:c-recourse:2026-07', 'bill:x-agent:c-recourse:2026-08'],
        lines: [
          { description: 'AI3 platform commission, 20% of $83.87 collected on invoice INV-1043', quantity: '1', amountMinor: '1677' },
          { description: 'AI3 platform commission, 20% of $350.00 collected on invoice INV-1044', quantity: '1', amountMinor: '7000' },
        ],
        totalMinor: '8677', pct: 20, dueDays: 30,
      }],
    });
    const r = await runMarket(deps(f), CO);
    expect(r.failures).toEqual([]);
    expect(r.commission).toEqual([{ number: expect.any(String), developer: 'Someone Else Ltd', total: '86.77', runs: 2 }]);
    const inv = (await listInvoices(db, CO)).find((i) => i.customerName === 'Someone Else Ltd')!;
    expect(inv.totalMinor).toBe('8677');
    expect(inv.status).toBe('issued');
    const told = f.wrote.find((w) => w.path === '/api/market/commission/issued')!;
    expect(told.body['refs']).toEqual(['bill:x-agent:c-recourse:2026-07', 'bill:x-agent:c-recourse:2026-08']);
    expect(told.body['number']).toBe(inv.number);
  });

  it('one buyer with bad data does not stop the others being invoiced', async () => {
    const bad: DueItem = { ...DUE, ref: 'bill:x-agent:c-broken:2026-08', lines: [], buyer: { companyId: 'c-broken', name: 'Broken Co', email: null } };
    const good: DueItem = { ...DUE, ref: 'bill:x-agent:c-good:2026-08', buyer: { companyId: 'c-good', name: 'Good Co', email: null } };
    const f = ai3({ due: [bad, good] });
    const r = await runMarket(deps(f), CO);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toContain('c-broken');
    expect(r.invoiced.map((i) => i.buyer)).toEqual(['Good Co']);
  });
});
