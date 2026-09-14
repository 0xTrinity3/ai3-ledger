// Millions of small facts, under a general ledger that stays readable.
//
// Posting every agent action as its own double-entry transaction gives a
// general ledger nobody can read and an audit trail where €4 of model spend is
// buried under a thousand rows of €0.004. These tests are about the shape that
// replaces it: a subledger with a card-style lifecycle, one journal a day, and
// one statement a month.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT, aggregate, authorise, balanceFor, balanceOf, capture, fund, listEvents, profitAndLoss,
  record, release, reserve, seedAccounts, statement, trialBalance,
} from '../src/core/index.js';

let db: PluginTestDb;
let CO = '';
let n = 0;

beforeAll(async () => { db = await openPluginTestDb(); });
afterAll(async () => { await db.close(); });
beforeEach(async () => {
  CO = `5ub1${String(n += 1).padStart(4, '0')}-1111-4111-8111-111111111111`;
  await seedAccounts(db, CO, 'EUR');
});

const DAY = { from: '2026-09-14T00:00:00.000Z', to: '2026-09-14T23:59:59.999Z' };
const at = (h: number) => `2026-09-14T${String(h).padStart(2, '0')}:00:00.000Z`;

describe('balances and the reservation lifecycle', () => {
  it('a prepayment gives the holder something to spend', async () => {
    const b = await fund(db, CO, { holder: 'customer:acme', currency: 'EUR', amountMinor: '10000' });
    expect(b.availableMinor).toBe('10000');
    expect(b.spendableMinor).toBe('10000');
    expect((await authorise(db, CO, { holder: 'customer:acme', currency: 'EUR', maxMinor: '400' })).ok).toBe(true);
    const no = await authorise(db, CO, { holder: 'customer:acme', currency: 'EUR', maxMinor: '20000' });
    expect(no.ok).toBe(false);
    expect(no.shortMinor).toBe('10000');
    expect(no.reason).toMatch(/has 10000 to spend/);
  });

  it('two agents cannot spend the same balance', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    // The first holds the lot.
    const first = await reserve(db, CO, { holder: 'agent:ops', currency: 'EUR', maxMinor: '1000' });
    expect(first.status).toBe('reserved');
    expect((await balanceFor(db, CO, 'agent:ops', 'EUR')).spendableMinor).toBe('0');
    // The second is refused, and the refusal says what is actually there.
    await expect(reserve(db, CO, { holder: 'agent:ops', currency: 'EUR', maxMinor: '1' }))
      .rejects.toThrow(/has 0 EUR to spend/);
  });

  it('an over-estimate is given back, not charged', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    const held = await reserve(db, CO, { holder: 'agent:ops', currency: 'EUR', maxMinor: '500' });
    const done = await capture(db, CO, held.id, { amountMinor: '120', quantity: '3', unitAmountMinor: '40' });

    expect(done.status).toBe('captured');
    expect(done.amountMinor).toBe('120');
    const b = await balanceFor(db, CO, 'agent:ops', 'EUR');
    expect(b.availableMinor).toBe('880');
    expect(b.reservedMinor).toBe('0', );
    expect(b.spendableMinor).toBe('880');
  });

  it('a released reservation costs nothing', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    const held = await reserve(db, CO, { holder: 'agent:ops', currency: 'EUR', maxMinor: '500' });
    const back = await release(db, CO, held.id);
    expect(back.status).toBe('released');
    expect((await balanceFor(db, CO, 'agent:ops', 'EUR')).availableMinor).toBe('1000');
    // And a capture after a release is refused rather than quietly charging.
    await expect(capture(db, CO, held.id, { amountMinor: '100' })).rejects.toThrow(/only a reservation can be captured/);
  });

  it('capturing more than was reserved is refused', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    const held = await reserve(db, CO, { holder: 'agent:ops', currency: 'EUR', maxMinor: '100' });
    await expect(capture(db, CO, held.id, { amountMinor: '101' })).rejects.toThrow(/more than the 100 reserved/);
  });

  it('a retry reserves and captures once', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    const a = await record(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '250', reference: 'run-1:tokens' });
    const b = await record(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '250', reference: 'run-1:tokens' });
    expect(b.id).toBe(a.id);
    expect((await balanceFor(db, CO, 'agent:ops', 'EUR')).availableMinor).toBe('750');
    expect((await listEvents(db, CO, { holder: 'agent:ops' })).length).toBe(1);
  });
});

describe('aggregation into the general ledger', () => {
  it('a thousand actions are one journal, and the detail is still addressable', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '100000' });
    for (let i = 0; i < 1000; i += 1) {
      await record(db, CO, {
        holder: 'agent:ops', currency: 'EUR', amountMinor: '4', kind: 'usage',
        counterparty: 'anthropic', sku: 'claude-opus-5', accountCode: ACCOUNT.MODEL_INFERENCE,
        occurredAt: at(9), reference: `tok-${i}`, subject: { agent: 'ops' },
      });
    }
    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });

    expect(r.events).toBe(1000);
    expect(r.amountMinor).toBe('4000');
    expect(r.groups.length).toBe(1);
    expect(r.transactionId).toBeTruthy();

    // One transaction in the general ledger, not a thousand.
    const tb = await trialBalance(db, CO);
    expect(tb.entryCount).toBe(2);
    // €40.00 of model inference, against the credits it was drawn from.
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(4000n);
    expect(await balanceOf(db, CO, ACCOUNT.CUSTOMER_CREDITS)).toBe(4000n);

    // And every event names the batch that swept it, so the summary opens.
    const swept = await listEvents(db, CO, { batchId: r.batchId!, limit: 2000 });
    expect(swept.length).toBe(1000);
    expect(swept[0]!.sku).toBe('claude-opus-5');
  });

  it('sweeping twice posts once', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    await record(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '400', occurredAt: at(9), counterparty: 'anthropic' });
    const first = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    const second = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(first.events).toBe(1);
    expect(second.events).toBe(0);
    expect(await balanceOf(db, CO, ACCOUNT.CUSTOMER_CREDITS)).toBe(400n);
  });

  it('a marketplace books its commission, not the gross', async () => {
    // €100 arrives and is theirs until they spend it: cash in, liability out.
    await fund(db, CO, { holder: 'customer:acme', currency: 'EUR', amountMinor: '10000', post: true });
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(10000n);
    expect(await balanceOf(db, CO, ACCOUNT.CUSTOMER_CREDITS)).toBe(10000n);

    await record(db, CO, {
      holder: 'customer:acme', currency: 'EUR', amountMinor: '400', passThroughMinor: '320',
      counterparty: 'provider:bluefin', sku: 'x-agent', occurredAt: at(10), kind: 'usage',
    });
    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(r.groups[0]!.passThroughMinor).toBe('320');

    // €4 of the €100 has been drawn down: the liability is what is left.
    expect(await balanceOf(db, CO, ACCOUNT.CUSTOMER_CREDITS)).toBe(9600n);
    expect(await balanceOf(db, CO, ACCOUNT.PROVIDER_PAYABLE)).toBe(320n);   // owed on
    expect(await balanceOf(db, CO, ACCOUNT.COMMISSION_REVENUE)).toBe(80n);  // ours

    // Revenue is the commission. Booking €4 would overstate it fivefold.
    const pnl = await profitAndLoss(db, CO, { from: '2026-09-01', to: '2026-09-30' });
    expect(pnl.incomeMinor).toBe('80');
  });

  it('two agents in one company settling with each other change nothing in the accounts', async () => {
    await fund(db, CO, { holder: 'agent:research', currency: 'EUR', amountMinor: '5000' });
    await record(db, CO, {
      holder: 'agent:research', currency: 'EUR', amountMinor: '250', internal: true,
      counterparty: 'agent:writer', sku: 'draft', occurredAt: at(11), kind: 'output',
    });
    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });

    expect(r.skippedInternal).toBe(1);
    expect(r.transactionId).toBe(null);
    expect((await trialBalance(db, CO)).entryCount).toBe(0);
    // The budget still moved: that is what an internal event is for.
    expect((await balanceFor(db, CO, 'agent:research', 'EUR')).availableMinor).toBe('4750');
    // And it is marked swept, so tomorrow does not look at it again.
    expect((await listEvents(db, CO, { batchId: r.batchId! })).length).toBe(1);
  });

  it('groups by account and counterparty, so one journal still says who and what', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '100000' });
    await record(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '600', counterparty: 'anthropic', accountCode: ACCOUNT.MODEL_INFERENCE, occurredAt: at(9) });
    await record(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '150', counterparty: 'exa', accountCode: ACCOUNT.TOOLS_AND_APIS, occurredAt: at(9) });
    await record(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '250', counterparty: 'anthropic', accountCode: ACCOUNT.MODEL_INFERENCE, occurredAt: at(10) });

    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(r.groups.length).toBe(2);
    const model = r.groups.find((g) => g.counterparty === 'anthropic')!;
    expect(model.amountMinor).toBe('850');
    expect(model.events).toBe(2);
    expect(await balanceOf(db, CO, ACCOUNT.MODEL_INFERENCE)).toBe(850n);
    expect(await balanceOf(db, CO, ACCOUNT.TOOLS_AND_APIS)).toBe(150n);
  });

  it('a reservation still open is not swept: nothing has been spent yet', async () => {
    await fund(db, CO, { holder: 'agent:ops', currency: 'EUR', amountMinor: '1000' });
    await reserve(db, CO, { holder: 'agent:ops', currency: 'EUR', maxMinor: '500', occurredAt: at(9) });
    const r = await aggregate(db, CO, { ...DAY, currency: 'EUR' });
    expect(r.events).toBe(0);
    expect(r.transactionId).toBe(null);
  });
});

describe('the statement', () => {
  it('is what a customer gets instead of a thousand invoices', async () => {
    await fund(db, CO, { holder: 'customer:acme', currency: 'EUR', amountMinor: '10000' });
    for (let i = 0; i < 3; i += 1) {
      await record(db, CO, {
        holder: 'customer:acme', currency: 'EUR', amountMinor: '100', quantity: '1000',
        counterparty: 'anthropic', sku: 'claude-opus-5', occurredAt: at(9 + i), reference: `m-${i}`,
      });
    }
    await record(db, CO, {
      holder: 'customer:acme', currency: 'EUR', amountMinor: '40', quantity: '2',
      counterparty: 'exa', sku: 'search', kind: 'usage', occurredAt: at(13), reference: 'search-1',
    });

    const s = await statement(db, CO, { holder: 'customer:acme', currency: 'EUR', ...DAY });
    expect(s.events).toBe(4);
    expect(s.spentMinor).toBe('340');
    expect(s.openingMinor).toBe('10000');
    expect(s.closingMinor).toBe('9660');
    // Grouped by what they spent it on, biggest first.
    expect(s.lines[0]!.counterparty).toBe('anthropic');
    expect(s.lines[0]!.amountMinor).toBe('300');
    expect(s.lines[0]!.quantity).toBe('3000.000000');
    expect(s.lines[1]!.sku).toBe('search');
  });
});

describe('the monthly invoice', () => {
  it('is one document for a month of continuous consumption', async () => {
    const { createCustomer, invoiceStatement, getInvoice, listInvoices } = await import('../src/core/index.js');
    const customer = await createCustomer(db, CO, { name: 'Acme', email: 'ap@acme.example' });
    await fund(db, CO, { holder: 'customer:acme', currency: 'EUR', amountMinor: '10000', post: true });
    for (let i = 0; i < 50; i += 1) {
      await record(db, CO, {
        holder: 'customer:acme', currency: 'EUR', amountMinor: '8', quantity: '1000',
        counterparty: 'anthropic', sku: 'claude-opus-5', occurredAt: at(9), reference: `m-${i}`,
      });
    }
    await record(db, CO, {
      holder: 'customer:acme', currency: 'EUR', amountMinor: '100',
      counterparty: 'exa', sku: 'search', occurredAt: at(11), reference: 'search-1',
    });

    const r = await invoiceStatement(db, CO, {
      holder: 'customer:acme', customerId: customer.id, currency: 'EUR', ...DAY, prepaid: true,
    });
    expect(r.totalMinor).toBe('500');
    expect(r.lines).toBe(2, );
    expect(r.number).toMatch(/^INV-/);

    // Fifty-one actions, one invoice, two lines — and it is already settled,
    // because they paid before they spent it.
    const inv = await getInvoice(db, CO, r.invoiceId!);
    expect(inv!.lines.length).toBe(2);
    expect(inv!.status).toBe('paid');
    expect(inv!.outstandingMinor).toBe('0');
    expect(inv!.lines[0]!.description).toMatch(/anthropic · claude-opus-5 · 50 events/);

    // Running the month again bills once.
    const again = await invoiceStatement(db, CO, { holder: 'customer:acme', customerId: customer.id, currency: 'EUR', ...DAY, prepaid: true });
    expect(again.alreadyBilled).toBe(true);
    expect(again.invoiceId).toBe(r.invoiceId);
    expect((await listInvoices(db, CO, {})).length).toBe(1);
  });

  it('a month with nothing in it is not a document', async () => {
    const { createCustomer, invoiceStatement } = await import('../src/core/index.js');
    const customer = await createCustomer(db, CO, { name: 'Quiet' });
    const r = await invoiceStatement(db, CO, { holder: 'customer:quiet', customerId: customer.id, currency: 'EUR', ...DAY });
    expect(r.invoiceId).toBe(null);
    expect(r.totalMinor).toBe('0');
  });
});
