/**
 * Hosted invoice pages and sending: the ai3.co client and the hosted
 * bookkeeping on the invoice. ai3.co itself is a fake fetch here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { createCustomer, createInvoice, getInvoice, getSettings, issueInvoice, markInvoiceOpened, markInvoiceSent, seedAccounts, setInvoiceHosted, updateSettings } from '../src/core/index.js';
import { Ai3Error, invoiceDocument, isConnected, publishInvoice, sendInvoice } from '../src/plugin/ai3.js';

const CO = '77777777-7777-4777-8777-777777777777';
let db: PluginTestDb;
let invoiceId: string;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  const c = await createCustomer(db, CO, { name: 'Northwind', email: 'ap@northwind.example' });
  const inv = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'Work', quantity: '1', unitAmountMinor: '50000' }] });
  invoiceId = inv.id;
  await issueInvoice(db, CO, inv.id, {});
});
afterAll(async () => { await db.close(); });

function fakeFetch(calls: Array<{ url: string; init?: RequestInit }>, reply: (url: string) => { status: number; body: unknown }) {
  return async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = reply(url);
    return new Response(JSON.stringify(r.body), { status: r.status, headers: { 'content-type': 'application/json' } });
  };
}

describe('hosted invoices', () => {
  it('is not connected until a key and origin are set', async () => {
    expect(isConnected(await getSettings(db, CO))).toBe(false);
    await updateSettings(db, CO, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test/' });
    expect(isConnected(await getSettings(db, CO))).toBe(true);
  });

  it('publishes the document with the company key and records the page', async () => {
    const settings = await getSettings(db, CO);
    const inv = (await getInvoice(db, CO, invoiceId))!;
    const doc = invoiceDocument(inv, settings, 'Test Co');
    expect(doc.number).toBe(inv.number);
    expect(doc.customer).toEqual({ name: 'Northwind', email: 'ap@northwind.example' });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(calls, () => ({ status: 200, body: { token: 'tok123', url: 'https://ai3.test/i/tok123' } }));
    const r = await publishInvoice(fetch, settings, inv, 'Test Co');
    expect(r).toMatchObject({ token: 'tok123', url: 'https://ai3.test/i/tok123' });
    expect(calls[0]!.url).toBe('https://ai3.test/api/ledger/invoices');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer ai3k_test');
    const sent = JSON.parse(String(calls[0]!.init!.body)) as { companyId: string; invoice: { number: string } };
    expect(sent.companyId).toBe(CO);
    expect(sent.invoice.number).toBe(inv.number);
    await setInvoiceHosted(db, CO, invoiceId, r);
    const after = (await getInvoice(db, CO, invoiceId))!;
    expect(after.hosted?.token).toBe('tok123');
    expect(after.hosted?.sentAt).toBeNull();
  });

  it('surfaces the ai3.co error message', async () => {
    const settings = await getSettings(db, CO);
    const inv = (await getInvoice(db, CO, invoiceId))!;
    const fetch = fakeFetch([], () => ({ status: 401, body: { error: 'Unknown company key' } }));
    await expect(publishInvoice(fetch, settings, inv, 'Test Co')).rejects.toThrow(Ai3Error);
    await expect(publishInvoice(fetch, settings, inv, 'Test Co')).rejects.toThrow('Unknown company key');
  });

  it('records sends and opens on the invoice', async () => {
    const settings = await getSettings(db, CO);
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetch = fakeFetch(calls, () => ({ status: 200, body: { sentAt: '2026-09-11T10:00:00.000Z', from: 'owner@example.com', via: 'gmail' } }));
    const r = await sendInvoice(fetch, settings, { companyId: CO, token: 'tok123', to: 'ap@northwind.example' });
    expect(r.via).toBe('gmail');
    expect(calls[0]!.url).toBe('https://ai3.test/api/ledger/invoices/tok123/send');
    await markInvoiceSent(db, CO, invoiceId, 'ap@northwind.example');
    await markInvoiceOpened(db, CO, invoiceId, '2026-09-11T11:00:00.000Z', 2);
    const inv = (await getInvoice(db, CO, invoiceId))!;
    expect(inv.hosted?.sentTo).toBe('ap@northwind.example');
    expect(inv.hosted?.sentAt).not.toBeNull();
    expect(inv.hosted?.openCount).toBe(2);
  });
});
