/**
 * M3: customers, invoices, receivables, payments. Runs under the plugin rules
 * (statements mode, host validators) because that is where it has to work.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb, PLUGIN_NAMESPACE } from './harness.js';
import {
  ACCOUNT,
  accountBalances,
  balanceOf,
  createCustomer,
  createInvoice,
  getInvoice,
  issueInvoice,
  listInvoices,
  position,
  receivablesOutstanding,
  recordPayment,
  seedAccounts,
  trialBalance,
  voidInvoice,
  writeOffInvoice,
} from '../src/core/index.js';

const CO = '55555555-5555-4555-8555-555555555555';
const OTHER = '66666666-6666-4666-8666-666666666666';

let db: PluginTestDb;
let customerId: string;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  await seedAccounts(db, OTHER, 'USD');
  const c = await createCustomer(db, CO, { name: 'Acme Studio', email: 'ap@acme.example' });
  customerId = c.id;
});

afterAll(async () => {
  await db.close();
});

async function incomeIn(from: string, to: string): Promise<bigint> {
  const rows = await accountBalances(db, CO, to, from);
  return rows.find((r) => r.code === ACCOUNT.SERVICE_INCOME)!.balanceMinor;
}

describe('M3 · drafts', () => {
  it('numbers invoices per company and totals the lines', async () => {
    const inv = await createInvoice(db, CO, {
      customerId,
      currency: 'USD',
      lines: [
        { description: 'Brief triage, 3 hours', quantity: 3, unitAmountMinor: 12_000 },
        { description: 'Proposal draft', unitAmountMinor: '25000' },
      ],
    });
    expect(inv.number).toBe('INV-0001');
    expect(inv.status).toBe('draft');
    expect(inv.totalMinor).toBe('61000');
    expect(inv.lines.length).toBe(2);
    const second = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'x', unitAmountMinor: 1 }] });
    expect(second.number).toBe('INV-0002');
    await voidInvoice(db, CO, second.id);
    expect((await getInvoice(db, CO, second.id))!.status).toBe('void');
  });

  it('AC8: a draft changes no report', async () => {
    const p = await position(db, CO);
    expect(p.receivablesMinor).toBe('0');
    expect(p.monthToDate.incomeMinor).toBe('0');
    expect((await trialBalance(db, CO)).entryCount).toBe(0);
    expect(await receivablesOutstanding(db, CO)).toBe(0n);
  });

  it('rounds fractional quantities to a minor unit, half up', async () => {
    const inv = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'Half hour', quantity: 0.5, unitAmountMinor: 12_001 }] });
    expect(inv.totalMinor).toBe('6001');
    await voidInvoice(db, CO, inv.id);
  });

  it('refuses an unknown customer and an empty invoice', async () => {
    await expect(createInvoice(db, CO, { customerId: '77777777-7777-4777-8777-777777777777', currency: 'USD', lines: [{ description: 'x', unitAmountMinor: 1 }] }))
      .rejects.toMatchObject({ code: 'invalid' });
    await expect(createInvoice(db, CO, { customerId, currency: 'USD', lines: [] })).rejects.toMatchObject({ code: 'invalid' });
  });
});

describe('M3 · issue, pay, write off', () => {
  it('AC5: issued in one period, paid in the next: income where issued, treasury where paid', async () => {
    const inv = (await listInvoices(db, CO, { status: 'draft' })).find((i) => i.number === 'INV-0001')!;
    const issued = await issueInvoice(db, CO, inv.id, { issuedAt: '2026-08-20T10:00:00Z' });
    expect(issued.status).toBe('issued');
    expect(issued.issuedAt).not.toBeNull();
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(61_000n);
    expect(await balanceOf(db, CO, ACCOUNT.SERVICE_INCOME)).toBe(61_000n);
    expect(await receivablesOutstanding(db, CO)).toBe(61_000n);

    // issuing twice books nothing twice
    await issueInvoice(db, CO, inv.id, { issuedAt: '2026-08-21T10:00:00Z' });
    expect(await balanceOf(db, CO, ACCOUNT.SERVICE_INCOME)).toBe(61_000n);

    const paid = await recordPayment(db, CO, inv.id, { amountMinor: 61_000, occurredAt: '2026-09-05T09:00:00Z', reference: 'bank-1' });
    expect(paid.status).toBe('paid');
    expect(paid.paidMinor).toBe('61000');
    expect(paid.outstandingMinor).toBe('0');

    expect(await incomeIn('2026-08-01T00:00:00Z', '2026-08-31T23:59:59Z')).toBe(61_000n);
    expect(await incomeIn('2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z')).toBe(0n);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY, '2026-08-31T23:59:59Z')).toBe(0n);
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY, '2026-09-30T23:59:59Z')).toBe(61_000n);
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(0n);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
  });

  it('takes partial payments, refuses overpayment, and derives the status', async () => {
    const inv = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'Retainer', unitAmountMinor: 100_000 }] });
    await issueInvoice(db, CO, inv.id, { issuedAt: '2026-09-02T00:00:00Z' });
    const part = await recordPayment(db, CO, inv.id, { amountMinor: 40_000, occurredAt: '2026-09-06T00:00:00Z', reference: 'bank-2' });
    expect(part.status).toBe('part_paid');
    expect(part.outstandingMinor).toBe('60000');
    // same bank reference twice is a no-op
    const again = await recordPayment(db, CO, inv.id, { amountMinor: 40_000, occurredAt: '2026-09-06T00:00:00Z', reference: 'bank-2' });
    expect(again.paidMinor).toBe('40000');
    await expect(recordPayment(db, CO, inv.id, { amountMinor: 60_001, reference: 'bank-3' })).rejects.toMatchObject({ code: 'invalid' });
    expect(await receivablesOutstanding(db, CO)).toBe(60_000n);
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(60_000n);
  });

  it('writes off what is outstanding: income out, receivable cleared, nothing deleted', async () => {
    const inv = (await listInvoices(db, CO, { status: 'part_paid' }))[0]!;
    const before = await trialBalance(db, CO);
    const off = await writeOffInvoice(db, CO, inv.id, { occurredAt: '2026-09-10T00:00:00Z', reason: 'customer folded' });
    expect(off.status).toBe('written_off');
    expect(off.outstandingMinor).toBe('0');
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(0n);
    expect(await balanceOf(db, CO, ACCOUNT.SERVICE_INCOME)).toBe(61_000n + 40_000n);
    const after = await trialBalance(db, CO);
    expect(after.entryCount).toBe(before.entryCount + 2);
    expect(after.netMinor).toBe(0n);
    await expect(recordPayment(db, CO, inv.id, { amountMinor: 1 })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses to issue into a closed period, naming it', async () => {
    await db.raw.query(
      `INSERT INTO "${PLUGIN_NAMESPACE}".periods (company_id, starts_on, ends_on, status, closed_at) VALUES ($1, '2026-07-01', '2026-07-31', 'closed', now())`,
      [CO],
    );
    const inv = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'Late', unitAmountMinor: 500 }] });
    await expect(issueInvoice(db, CO, inv.id, { issuedAt: '2026-07-15T00:00:00Z' })).rejects.toMatchObject({
      code: 'period_closed',
      message: expect.stringContaining('2026-07-01..2026-07-31'),
    });
    expect((await getInvoice(db, CO, inv.id))!.status).toBe('draft');
  });

  it('AC10: another company cannot see or issue this company\'s invoice', async () => {
    const inv = (await listInvoices(db, CO, { status: 'draft' }))[0]!;
    expect(await getInvoice(db, OTHER, inv.id)).toBeNull();
    await expect(issueInvoice(db, OTHER, inv.id)).rejects.toMatchObject({ code: 'invalid' });
    expect((await listInvoices(db, OTHER)).length).toBe(0);
    expect(await receivablesOutstanding(db, OTHER)).toBe(0n);
  });

  it('position reports receivables from the same figures', async () => {
    const inv = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'Open', unitAmountMinor: 7_500 }] });
    await issueInvoice(db, CO, inv.id);
    const p = await position(db, CO);
    expect(p.receivablesMinor).toBe('7500');
    expect(await receivablesOutstanding(db, CO)).toBe(7_500n);
    expect(p.balanceSheet.balances).toBe(true);
  });
});

describe('voiding an issued invoice', () => {
  it('reverses the issue posting when nothing was paid, and refuses once paid', async () => {
    const before = await balanceOf(db, CO, ACCOUNT.RECEIVABLES);
    const inv = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'Raised in error', quantity: '1', unitAmountMinor: '7000' }] });
    await issueInvoice(db, CO, inv.id, {});
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(before + 7000n);
    const voided = await voidInvoice(db, CO, inv.id, { reason: 'duplicate' });
    expect(voided.status).toBe('void');
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(before);
    const paid = await createInvoice(db, CO, { customerId, currency: 'USD', lines: [{ description: 'Paid', quantity: '1', unitAmountMinor: '1000' }] });
    await issueInvoice(db, CO, paid.id, {});
    await recordPayment(db, CO, paid.id, { amountMinor: 500n, reference: 'p1' });
    await expect(voidInvoice(db, CO, paid.id)).rejects.toThrow(/payments on it/);
  });
});
