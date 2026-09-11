/**
 * Multi-currency invoices and payment options, under the plugin rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT,
  balanceOf,
  balanceSheet,
  createCustomer,
  createInvoice,
  createPaymentMethod,
  getInvoice,
  getSettings,
  issueInvoice,
  listPaymentMethods,
  parseRate,
  recordPayment,
  seedAccounts,
  setInvoicePaymentMethods,
  toBase,
  trialBalance,
  updatePaymentMethod,
  updateSettings,
} from '../src/core/index.js';

const CO = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
let db: PluginTestDb;
let customerId: string;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  customerId = (await createCustomer(db, CO, { name: 'Berlin Studio GmbH', email: 'ap@berlin.example' })).id;
});
afterAll(async () => {
  await db.close();
});

describe('rates', () => {
  it('keeps ten decimal places and rounds half up to a minor unit', () => {
    expect(parseRate('1.085')).toBe(10_850_000_000n);
    expect(toBase(10_000n, parseRate('1.085'))).toBe(10_850n);
    expect(toBase(1n, parseRate('0.5'))).toBe(1n); // 0.5 rounds up
    expect(toBase(333n, parseRate('0.3333333333'))).toBe(111n);
    expect(() => parseRate('-1')).toThrow();
    expect(() => parseRate('abc')).toThrow();
  });
});

describe('settings and payment options', () => {
  it('defaults the base currency and keeps company details', async () => {
    expect((await getSettings(db, CO)).baseCurrency).toBe('USD');
    const s = await updateSettings(db, CO, { legalName: 'AI3 Test Ltd', address: '1 Agent Way, London', email: 'billing@ai3.example', taxId: 'GB123' });
    expect(s.legalName).toBe('AI3 Test Ltd');
    expect(s.baseCurrency).toBe('USD');
  });

  it('stores bank, Stripe and crypto options and validates each', async () => {
    const bank = await createPaymentMethod(db, CO, { kind: 'bank', label: 'Mercury (USD)', currency: 'USD', details: { accountName: 'AI3 Test Ltd', bankName: 'Mercury', accountNumber: '123456789', routingNumber: '021000021' } });
    const stripe = await createPaymentMethod(db, CO, { kind: 'stripe', label: 'Pay by card', details: { url: 'https://buy.stripe.com/test_abc' } });
    const usdc = await createPaymentMethod(db, CO, { kind: 'crypto', label: 'USDC on Base', currency: 'USDC', details: { network: 'Base', asset: 'USDC', address: '0x1234567890abcdef1234567890abcdef12345678' } });
    expect([bank.kind, stripe.kind, usdc.kind]).toEqual(['bank', 'stripe', 'crypto']);
    await expect(createPaymentMethod(db, CO, { kind: 'crypto', label: 'x', details: { asset: 'ETH' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createPaymentMethod(db, CO, { kind: 'stripe', label: 'x', details: { url: 'http://insecure' } })).rejects.toMatchObject({ code: 'invalid' });
    await expect(createPaymentMethod(db, CO, { kind: 'bank', label: 'x', details: { bankName: 'Nowhere' } })).rejects.toMatchObject({ code: 'invalid' });
    const all = await listPaymentMethods(db, CO);
    expect(all.length).toBe(3);
    // a disabled option is not printed on new invoices
    await updatePaymentMethod(db, CO, stripe.id, { enabled: false });
    expect((await listPaymentMethods(db, CO, { enabledOnly: true })).map((m) => m.label)).toEqual(['Mercury (USD)', 'USDC on Base']);
  });
});

describe('multi-currency invoices', () => {
  it('needs a rate when the invoice is not in base, and prints the default payment options', async () => {
    await expect(createInvoice(db, CO, { customerId, currency: 'EUR', lines: [{ description: 'x', unitAmountMinor: 100 }] })).rejects.toMatchObject({ code: 'invalid' });
    const inv = await createInvoice(db, CO, { customerId, currency: 'EUR', rateToBase: '1.10', lines: [{ description: 'Design sprint', unitAmountMinor: 100_000 }], notes: 'Thank you' });
    expect(inv.currency).toBe('EUR');
    expect(inv.baseCurrency).toBe('USD');
    expect(inv.totalMinor).toBe('100000');
    expect(inv.baseTotalMinor).toBe('110000');
    expect(inv.rateToBase).toBe('1.1');
    expect(inv.paymentMethods.map((m) => m.label)).toEqual(['Mercury (USD)', 'USDC on Base']);
    expect(inv.paymentMethods[1]!.details.address).toContain('0x1234');
    expect(inv.notes).toBe('Thank you');
  });

  it('lets a draft pick which options to print, then freezes them at issue', async () => {
    const all = await listPaymentMethods(db, CO);
    const usdc = all.find((m) => m.kind === 'crypto')!;
    const draft = await createInvoice(db, CO, { customerId, currency: 'USDC', rateToBase: '1', lines: [{ description: 'Paid in stablecoin', unitAmountMinor: 50_000 }], paymentMethodIds: [usdc.id] });
    expect(draft.paymentMethods.map((m) => m.label)).toEqual(['USDC on Base']);
    const changed = await setInvoicePaymentMethods(db, CO, draft.id, [usdc.id, all.find((m) => m.kind === 'bank')!.id]);
    expect(changed.paymentMethods.length).toBe(2);
    const issued = await issueInvoice(db, CO, draft.id, { issuedAt: '2026-09-01T00:00:00Z' });
    expect(issued.status).toBe('issued');
    await expect(setInvoicePaymentMethods(db, CO, draft.id, [])).rejects.toMatchObject({ code: 'invalid' });
    // the receivable is booked in base at the rate: 500 USDC at 1 = $500
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(50_000n);
  });

  it('books a currency gain when the payment rate beats the issue rate, and the sheet balances', async () => {
    const inv = (await import('../src/core/index.js').then((m) => m.listInvoices(db, CO, { status: 'draft' }))).find((i) => i.currency === 'EUR')!;
    await issueInvoice(db, CO, inv.id, { issuedAt: '2026-09-02T00:00:00Z' });
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(50_000n + 110_000n);
    // part payment of €400 when the euro is worth $1.15
    const part = await recordPayment(db, CO, inv.id, { amountMinor: 40_000, rateToBase: '1.15', occurredAt: '2026-09-10T00:00:00Z', reference: 'sepa-1' });
    expect(part.status).toBe('part_paid');
    expect(part.paidMinor).toBe('40000');
    expect(part.outstandingMinor).toBe('60000');
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(46_000n); // $460 arrived
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(50_000n + 110_000n - 44_000n); // relieved at 1.10
    expect(await balanceOf(db, CO, ACCOUNT.CURRENCY_GAINS)).toBe(2_000n); // $20 gain
    // the rest at 1.05: a loss, and the receivable clears exactly
    const rest = await recordPayment(db, CO, inv.id, { amountMinor: 60_000, rateToBase: '1.05', occurredAt: '2026-09-20T00:00:00Z', reference: 'sepa-2' });
    expect(rest.status).toBe('paid');
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(50_000n);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(46_000n + 63_000n);
    expect(await balanceOf(db, CO, ACCOUNT.CURRENCY_GAINS)).toBe(2_000n - 3_000n);
    expect((await getInvoice(db, CO, inv.id))!.payments.length).toBe(2);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
    expect((await balanceSheet(db, CO)).balances).toBe(true);
  });

  it('refuses a repeated payment reference and an overpayment', async () => {
    const inv = (await import('../src/core/index.js').then((m) => m.listInvoices(db, CO, { status: 'issued' }))).find((i) => i.currency === 'USDC')!;
    const first = await recordPayment(db, CO, inv.id, { amountMinor: 10_000, reference: 'tx-0xabc' });
    expect(first.paidMinor).toBe('10000');
    const again = await recordPayment(db, CO, inv.id, { amountMinor: 10_000, reference: 'tx-0xabc' });
    expect(again.paidMinor).toBe('10000');
    await expect(recordPayment(db, CO, inv.id, { amountMinor: 40_001, reference: 'tx-0xdef' })).rejects.toMatchObject({ code: 'invalid' });
  });
});
