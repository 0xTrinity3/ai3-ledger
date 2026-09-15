/**
 * Stripe through ai3.co: the link rows, the invoice payment option, the
 * balance feed into the books, and paying another company's invoice by the
 * saved card. ai3.co and Stripe are a fake fetch; the books are real (pglite).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { ACCOUNT, accountBalances, createPaymentMethod, getInvoice, getSettings, getStripeLink, listBankAccounts, listInvoices, listPaymentMethods, listStatementLines, saveStripeLink, seedAccounts, updateSettings } from '../src/core/index.js';
import { ensureStripeAccounts, linesFromStripe, payInvoiceByCard, syncStripeFeed, STRIPE_BANK_NAME, STRIPE_CARD_BANK_NAME } from '../src/plugin/stripe.js';
import { runTool, type ToolDeps } from '../src/plugin/tools.js';

const CO = '55555555-5555-4555-8555-555555555555';
const RUN = { agentId: 'agent-1', runId: 'run-1', companyId: CO, projectId: null };

let db: PluginTestDb;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let feed: Array<Record<string, unknown>> = [];
let payReply: { status: number; body: unknown } = { status: 200, body: {} };

const fetch = async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  let reply: unknown = {};
  let status = 200;
  if (url.endsWith('/api/ledger/stripe/status') || url.endsWith('/api/ledger/stripe/connect')) {
    reply = { connected: true, accountId: 'acct_TEST123', type: 'standard', chargesEnabled: true, payoutsEnabled: true, detailsSubmitted: true, defaultCurrency: 'USD', requirementsDue: [], disabledReason: null, test: true, card: { brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030 }, cardUrl: 'https://ai3.test/companies/card?id=abc', creditsUrl: 'https://ai3.test/companies/credits?id=abc', dashboardUrl: 'https://dashboard.stripe.com/', onboardingUrl: url.endsWith('/connect') ? null : undefined };
  } else if (url.endsWith('/api/ledger/stripe/transactions')) {
    reply = { lines: feed, cursorUnix: 1_800_000_100, hasMore: false, connected: true };
  } else if (url.endsWith('/api/ledger/stripe/pay')) {
    reply = payReply.body;
    status = payReply.status;
  } else if (url.endsWith('/api/ledger/agent-pay/check')) {
    // The owner has authorised this payee and the window has closed.
    reply = { allowed: true, code: 'ok', authorityId: 'auth_' + 'a'.repeat(24) };
  } else if (url.endsWith('/api/ledger/agent-pay/paid')) {
    reply = { ok: true, paymentId: 'pay_1', authorityId: 'auth_' + 'a'.repeat(24) };
  } else if (url.endsWith('.json')) {
    reply = { number: 'INV-0042', currency: 'USD', totalMinor: '15000', outstandingMinor: '15000', status: 'issued', lines: [], paymentMethods: [{ kind: 'stripe', label: 'Pay by card', details: { account: 'acct_SELLER' } }], company: { name: 'Seller Co', email: null }, stripe: { payable: true, test: true } };
  } else if (url.endsWith('/api/ledger/invoices')) {
    reply = { token: 'tok1', url: 'https://ai3.test/i/tok1' };
  }
  return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
};

let deps: ToolDeps;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  await updateSettings(db, CO, { baseCurrency: 'USD', ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
  deps = { db, fetch, companyName: async () => 'Stripe Co', baseCurrency: 'USD' };
});
afterAll(async () => { await db.close(); });

describe('payment options', () => {
  it('accepts a connected account as a Stripe option, and still a link', async () => {
    const m = await createPaymentMethod(db, CO, { kind: 'stripe', label: 'Card', currency: null, details: { account: 'acct_X1' }, isDefault: false });
    expect(m.details).toEqual({ account: 'acct_X1' });
    await expect(createPaymentMethod(db, CO, { kind: 'stripe', label: 'Bad', currency: null, details: { account: 'nope' }, isDefault: false })).rejects.toThrow(/acct_/);
    await expect(createPaymentMethod(db, CO, { kind: 'stripe', label: 'Bad', currency: null, details: {}, isDefault: false })).rejects.toThrow(/payment link, or a connected/);
  });
});

describe('link and accounts', () => {
  it('stores the link and creates the Stripe bank account and the invoice option once', async () => {
    const remote = { connected: true, accountId: 'acct_TEST123', type: 'standard', chargesEnabled: true, payoutsEnabled: false, detailsSubmitted: true, defaultCurrency: 'USD', requirementsDue: [], disabledReason: null, test: true, card: null, cardUrl: null, creditsUrl: null, dashboardUrl: null };
    const link = await ensureStripeAccounts(db, CO, remote, 'USD');
    expect(link.accountId).toBe('acct_TEST123');
    expect(link.bankAccountId).toBeTruthy();
    expect(link.paymentMethodId).toBeTruthy();
    const again = await ensureStripeAccounts(db, CO, remote, 'USD');
    expect(again.bankAccountId).toBe(link.bankAccountId);
    const banks = await listBankAccounts(db, CO);
    const stripeBank = banks.find((b) => b.name === STRIPE_BANK_NAME);
    expect(stripeBank).toMatchObject({ kind: 'stripe', feed: 'stripe', currency: 'USD' });
    const methods = (await listPaymentMethods(db, CO)).filter((m) => m.kind === 'stripe' && m.details.account === 'acct_TEST123');
    expect(methods).toHaveLength(1);
    expect(methods[0]!.isDefault).toBe(true);
    const saved = await saveStripeLink(db, CO, { feedCursorUnix: 1_800_000_000 });
    expect(saved.feedCursorUnix).toBe(1_800_000_000);
    expect((await getStripeLink(db, CO))?.chargesEnabled).toBe(true);
  });
});

describe('the feed', () => {
  it('turns ai3.co lines into statement lines', () => {
    const lines = linesFromStripe([
      { id: 'txn_1', at: '2026-09-12T10:00:00.000Z', amountMinor: '15000', currency: 'USD', description: 'Invoice INV-0001 · Northwind', payee: 'Northwind', reference: 'INV-0001', kind: 'charge', sourceId: 'ch_1', invoiceNumber: 'INV-0001' },
      { id: 'txn_1:fee', at: '2026-09-12T10:00:00.000Z', amountMinor: '-465', currency: 'USD', description: 'Stripe fee for Invoice INV-0001', payee: 'Stripe', reference: 'fee:ch_1', kind: 'fee', sourceId: 'ch_1', invoiceNumber: 'INV-0001' },
      { id: 'txn_zero', at: '2026-09-12T10:00:00.000Z', amountMinor: '0', currency: 'USD', description: 'nothing', payee: null, reference: null, kind: 'adjustment', sourceId: null, invoiceNumber: null },
    ]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ amountMinor: 15000n, reference: 'INV-0001', externalId: 'stripe:txn_1', payee: 'Northwind' });
    expect(lines[1]).toMatchObject({ amountMinor: -465n, externalId: 'stripe:txn_1:fee' });
  });

  it('imports a charge that pays an invoice and posts the fee to payment processing', async () => {
    const made = await runTool(deps, 'create-invoice', { customer: 'Northwind', lines: [{ description: 'Design sprint', unitAmount: '150.00' }] }, RUN);
    expect(made.error).toBeUndefined();
    const number = (made.data as { number: string }).number;
    const invoiceId = (made.data as { invoiceId: string }).invoiceId;
    feed = [
      { id: 'txn_a', at: '2026-09-12T10:00:00.000Z', amountMinor: '15000', currency: 'USD', description: `Invoice ${number} · Northwind`, payee: 'Northwind', reference: number, kind: 'charge', sourceId: 'ch_a', invoiceNumber: number },
      { id: 'txn_a:fee', at: '2026-09-12T10:00:00.000Z', amountMinor: '-465', currency: 'USD', description: `Stripe fee for Invoice ${number}`, payee: 'Stripe', reference: 'fee:ch_a', kind: 'fee', sourceId: 'ch_a', invoiceNumber: number },
    ];
    const settings = await getSettings(db, CO);
    const r = await syncStripeFeed(db, fetch, settings, CO, { by: 'test' });
    expect(r).toMatchObject({ imported: 2, duplicates: 0, cursorUnix: 1_800_000_100 });
    expect(r!.autoPosted).toBe(2);
    expect(r!.leftForReview).toBe(0);
    const sent = calls.find((c) => c.url.endsWith('/api/ledger/stripe/transactions'));
    expect(sent?.body).toMatchObject({ companyId: CO, sinceUnix: 1_800_000_000 });
    const inv = await getInvoice(db, CO, invoiceId);
    expect(inv?.status).toBe('paid');
    const link = await getStripeLink(db, CO);
    const lines = await listStatementLines(db, CO, link!.bankAccountId!, { limit: 10 });
    expect(lines.map((l) => l.status).sort()).toEqual(['created', 'created']);
    const balances = await accountBalances(db, CO);
    const fees = balances.find((b) => b.code === '5300');
    expect(String(fees?.balanceMinor)).toBe('465');
    // Running again with the same lines imports nothing new.
    const again = await syncStripeFeed(db, fetch, settings, CO, { by: 'test' });
    expect(again).toMatchObject({ imported: 0, duplicates: 2 });
  });
});

describe('paying by card', () => {
  it('pays another company through ai3.co and books it against the card account', async () => {
    payReply = { status: 200, body: { paymentIntentId: 'pi_777', status: 'succeeded', amountMinor: '15000', currency: 'USD', invoiceNumber: 'INV-0042', seller: 'Seller Co', feeMinor: '0', at: '2026-09-12T11:00:00.000Z', card: { brand: 'visa', last4: '4242' } } };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: 'https://ai3.test/i/abcdefghijklmnopqrstuv', rail: 'stripe', accountCode: ACCOUNT.TOOLS_AND_APIS }, RUN);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain('Paid 150.00 USD by card');
    expect(r.data).toMatchObject({ rail: 'stripe', paymentIntentId: 'pi_777', invoice: 'INV-0042', accountCode: '5100' });
    const paid = calls.find((c) => c.url.endsWith('/api/ledger/stripe/pay'));
    expect(paid?.body).toMatchObject({ companyId: CO, invoiceUrl: 'https://ai3.test/i/abcdefghijklmnopqrstuv' });
    // The gate was asked before the card was charged, and told afterwards.
    const idx = (suffix: string) => calls.findIndex((c) => c.url.endsWith(suffix));
    expect(idx('/api/ledger/agent-pay/check')).toBeGreaterThan(-1);
    expect(idx('/api/ledger/agent-pay/check')).toBeLessThan(idx('/api/ledger/stripe/pay'));
    expect(calls[idx('/api/ledger/agent-pay/paid')]?.body).toMatchObject({ companyId: CO, amountMinor: '15000', invoiceId: 'INV-0042', rail: 'stripe', txHash: 'pi_777', authorityId: 'auth_' + 'a'.repeat(24) });
    expect(r.content).toContain('spending authority');
    const card = (await listBankAccounts(db, CO)).find((b) => b.name === STRIPE_CARD_BANK_NAME);
    expect(card).toMatchObject({ kind: 'card' });
    const balances = await accountBalances(db, CO);
    expect(String(balances.find((b) => b.code === card!.accountCode)?.balanceMinor)).toBe('-15000');
    expect(String(balances.find((b) => b.code === '5100')?.balanceMinor)).toBe('15000');
  });

  it('auto picks the card when the wallet cannot cover it, and explains a refusal', async () => {
    payReply = { status: 409, body: { error: 'No card on file for this company. The owner can add one at https://ai3.test/companies/card?id=abc' } };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: 'https://ai3.test/i/abcdefghijklmnopqrstuv', rail: 'stripe' }, RUN);
    expect(r.error).toMatch(/No card on file/);
    expect((await listInvoices(db, CO)).length).toBeGreaterThan(0);
  });

  it('reports the Stripe state through the stripe tool', async () => {
    const r = await runTool(deps, 'stripe', {}, RUN);
    expect(r.error).toBeUndefined();
    expect(r.content).toContain('card payments on');
    expect(r.content).toContain('visa ····4242');
    expect(r.data).toMatchObject({ connected: true, chargesEnabled: true, test: true });
  });

  it('direct card payment through payInvoiceByCard needs the ai3.co connection', async () => {
    const settings = { ...(await getSettings(db, CO)), ai3Key: null, ai3Origin: null };
    await expect(payInvoiceByCard(db, fetch, settings, CO, { invoiceUrl: 'https://ai3.test/i/abcdefghijklmnopqrstuv', amountCents: null, description: null, accountCode: null, by: 'test' })).rejects.toThrow(/ai3.co connection/);
  });
});
