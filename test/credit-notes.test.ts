// A credit note is not a payment.
//
// The only ways to reduce an invoice were to receive money against it or to
// write the whole thing off, so a partial credit — what a dispute ruling
// produces, and what anybody issues when they have overbilled — was being done
// as a "payment". The books then said cash had arrived that never did.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  accountBalances, createCustomer, createInvoice, creditInvoice, issueInvoice, recordPayment, seedAccounts,
} from '../src/core/index.js';

// A company per test: these assert whole-company balances, and one ledger
// shared across tests would have every earlier invoice in the figure.
let db: PluginTestDb;
let CO = '';
let n = 0;

beforeAll(async () => { db = await openPluginTestDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  CO = `7777${String(n += 1).padStart(4, '0')}-7777-4777-8777-777777777777`;
  await seedAccounts(db, CO, 'USD', { version: 1 });
});

async function anInvoice(totalMinor = '10000') {
  const c = await createCustomer(db, CO, { name: 'Bluefin', email: 'pay@bluefin.co' });
  const draft = await createInvoice(db, CO, {
    customerId: c.id, currency: 'USD',
    lines: [{ description: 'Consulting', quantity: '1', unitAmountMinor: totalMinor }],
  });
  return issueInvoice(db, CO, draft.id, { by: 'test' });
}

/** This invoice's own contribution to an account, which is what each test is about. */
const balance = async (code: string) => String((await accountBalances(db, CO)).find((a) => a.code === code)?.balanceMinor ?? '0');

describe('credit notes', () => {

  it('reduces what is owed without claiming anybody paid', async () => {
    const inv = await anInvoice('10000');
    const after = await creditInvoice(db, CO, inv.id, { amountMinor: '2500', reason: 'Recourse ruling dsp_1: 25% of the fault with us', createdBy: 'ai3' });

    expect(after.outstandingMinor).toBe('7500');
    expect(after.creditedMinor).toBe('2500');
    expect(after.paidMinor).toBe('0');
    expect(after.status).toBe('issued');

    // Income came back out; the receivable fell by the same amount.
    expect(await balance('4000')).toBe('7500');
    expect(await balance('1100')).toBe('7500');

    const credit = after.payments.find((p) => p.kind === 'credit');
    expect(credit?.amountMinor).toBe('2500');
    expect(credit?.reason).toMatch(/Recourse ruling/);
  });

  it('a payment and a credit on the same invoice stay distinguishable', async () => {
    const inv = await anInvoice('10000');
    await recordPayment(db, CO, inv.id, { amountMinor: '4000', accountCode: '1000', occurredAt: new Date(), by: 'test' });
    const after = await creditInvoice(db, CO, inv.id, { amountMinor: '1000', reason: 'overbilled by an hour' });

    expect(after.paidMinor).toBe('4000');
    expect(after.creditedMinor).toBe('1000');
    expect(after.outstandingMinor).toBe('5000');
    expect(after.status).toBe('part_paid');
    // Cash is what actually arrived, and no more.
    expect(await balance('1000')).toBe('4000');
  });

  it('crediting the whole balance settles it, and calls it what it is', async () => {
    const inv = await anInvoice('10000');
    const after = await creditInvoice(db, CO, inv.id, { amountMinor: '10000', reason: 'the ruling went entirely against us' });
    expect(after.outstandingMinor).toBe('0');
    expect(after.status).toBe('written_off');
    // Nothing is left in income or receivables from this invoice.
    expect(await balance('4000')).toBe('0');
    expect(await balance('1100')).toBe('0');
  });

  it('a part-paid invoice credited to zero is paid, not written off', async () => {
    const inv = await anInvoice('10000');
    await recordPayment(db, CO, inv.id, { amountMinor: '6000', accountCode: '1000', occurredAt: new Date(), by: 'test' });
    const after = await creditInvoice(db, CO, inv.id, { amountMinor: '4000', reason: 'the rest was disputed and conceded' });
    expect(after.status).toBe('paid');
    expect(after.outstandingMinor).toBe('0');
  });

  it('cannot credit more than is outstanding, or without a reason', async () => {
    const inv = await anInvoice('10000');
    await expect(creditInvoice(db, CO, inv.id, { amountMinor: '20000', reason: 'too much' })).rejects.toThrow(/exceeds/);
    await expect(creditInvoice(db, CO, inv.id, { amountMinor: '100', reason: '' })).rejects.toThrow(/needs a reason/);
    await expect(creditInvoice(db, CO, inv.id, { amountMinor: '0', reason: 'nothing' })).rejects.toThrow();
  });

  it('the same reference twice credits once, because a machine issues these', async () => {
    const inv = await anInvoice('10000');
    await creditInvoice(db, CO, inv.id, { amountMinor: '1000', reason: 'ruling', reference: 'dispute:bill:x:1' });
    const again = await creditInvoice(db, CO, inv.id, { amountMinor: '1000', reason: 'ruling', reference: 'dispute:bill:x:1' });
    expect(again.creditedMinor).toBe('1000');
    expect(again.outstandingMinor).toBe('9000');
  });

  it('a draft or a written-off invoice cannot be credited', async () => {
    const c = await createCustomer(db, CO, { name: 'X' });
    const draft = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'w', quantity: '1', unitAmountMinor: '100' }] });
    await expect(creditInvoice(db, CO, draft.id, { amountMinor: '50', reason: 'no' })).rejects.toThrow(/only an issued invoice/);
  });
});
