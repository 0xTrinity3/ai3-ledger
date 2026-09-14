/**
 * Bills: suppliers, approval, payment, void, tax; documents attached to them;
 * tax and line accounts on invoices. Plugin rules throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT,
  addDocument,
  approveBill,
  balanceOf,
  createBill,
  createCustomer,
  createInvoice,
  createSupplier,
  deleteBill,
  getBill,
  getTransaction,
  issueInvoice,
  listBills,
  listDocumentsFor,
  payBill,
  payablesOutstanding,
  readDocument,
  recordPayment,
  resolveSupplier,
  seedAccounts,
  updateBill,
  voidBill,
  trialBalanceReport,
} from '../src/core/index.js';

const CO = 'b1b1b1b1-b1b1-4b1b-8b1b-b1b1b1b1b1b1';
let db: PluginTestDb;
let supplierId: string;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  const s = await createSupplier(db, CO, { name: 'Hetzner', email: 'billing@hetzner.example', defaultAccountCode: ACCOUNT.COMPUTE_AND_SANDBOXES });
  supplierId = s.id;
});

afterAll(async () => {
  await db.close();
});

describe('bills', () => {
  it('drafts a bill from lines with tax and the supplier default account, posting nothing', async () => {
    const b = await createBill(db, CO, {
      supplierId,
      reference: 'R0012345',
      issuedAt: '2026-08-03T00:00:00Z',
      dueAt: '2026-08-17T00:00:00Z',
      lines: [
        { description: 'CX32 server, August', unitAmountMinor: 1_200n, taxMinor: 228n },
        { description: 'Backups', unitAmountMinor: 240n, taxMinor: 46n, accountCode: ACCOUNT.TOOLS_AND_APIS },
      ],
    });
    expect(b.number).toBe('BILL-0001');
    expect(b.status).toBe('draft');
    expect(b.subtotalMinor).toBe('1440');
    expect(b.taxMinor).toBe('274');
    expect(b.totalMinor).toBe('1714');
    expect(b.lines[0]!.accountCode).toBe('5200');
    expect(b.lines[1]!.accountCode).toBe('5100');
    expect(await balanceOf(db, CO, '2000')).toBe(0n);
  });

  it('approves: expense per account, tax to 2100, payable for the total', async () => {
    const b = (await listBills(db, CO))[0]!;
    const a = await approveBill(db, CO, b.id, { createdBy: 'tester' });
    expect(a.status).toBe('approved');
    expect(a.outstandingMinor).toBe('1714');
    expect(await balanceOf(db, CO, '2000')).toBe(1_714n);
    expect(await balanceOf(db, CO, '2100')).toBe(-274n); // liability with a debit balance: tax to reclaim
    expect(await balanceOf(db, CO, '5200')).toBe(1_200n);
    expect(await balanceOf(db, CO, '5100')).toBe(240n);
    const tx = await getTransaction(db, CO, a.transactionId!);
    expect(tx?.sourceKind).toBe('bill');
    expect(tx?.entries.length).toBe(4);
    expect((await approveBill(db, CO, b.id)).transactionId).toBe(a.transactionId);
    expect(await payablesOutstanding(db, CO)).toBe(1_714n);
  });

  it('pays in part then in full from Treasury and derives the status', async () => {
    const b = (await listBills(db, CO))[0]!;
    const p1 = await payBill(db, CO, b.id, { amountMinor: 1_000n, occurredAt: '2026-08-10T00:00:00Z', reference: 'wire-1' });
    expect(p1.status).toBe('part_paid');
    expect(p1.outstandingMinor).toBe('714');
    expect((await payBill(db, CO, b.id, { amountMinor: 700n, reference: 'wire-1' })).paidMinor).toBe('1000'); // same reference again is a no-op
    const p2 = await payBill(db, CO, b.id, { occurredAt: '2026-08-12T00:00:00Z', reference: 'wire-2' });
    expect(p2.status).toBe('paid');
    expect(await balanceOf(db, CO, '2000')).toBe(0n);
    expect(await balanceOf(db, CO, '1000')).toBe(-1_714n);
    await expect(payBill(db, CO, b.id, { amountMinor: 1n })).rejects.toThrow(/only an approved bill/);
  });

  it('edits and deletes drafts, voids approved bills by reversal, refuses to void paid ones', async () => {
    const d = await createBill(db, CO, { supplierId, lines: [{ description: 'x', unitAmountMinor: 100n }] });
    const e = await updateBill(db, CO, d.id, { reference: 'ABC', lines: [{ description: 'y', unitAmountMinor: 300n }] });
    expect(e.reference).toBe('ABC');
    expect(e.totalMinor).toBe('300');
    expect((await deleteBill(db, CO, d.id)).deleted).toBe(true);
    expect(await getBill(db, CO, d.id)).toBeNull();

    const paid = (await listBills(db, CO, { status: 'paid' }))[0]!;
    await expect(voidBill(db, CO, paid.id)).rejects.toThrow(/payments on it/);

    const b = await createBill(db, CO, { supplierId, issuedAt: '2026-08-20T00:00:00Z', lines: [{ description: 'Mistake', unitAmountMinor: 5_000n }] });
    await approveBill(db, CO, b.id);
    expect(await balanceOf(db, CO, '2000')).toBe(5_000n);
    const v = await voidBill(db, CO, b.id, { reason: 'duplicate' });
    expect(v.status).toBe('void');
    expect(await balanceOf(db, CO, '2000')).toBe(0n);
    expect(await balanceOf(db, CO, '5200')).toBe(1_200n);
    const tb = await trialBalanceReport(db, CO);
    expect(tb.balances).toBe(true);
  });

  it('resolves suppliers by id or name and creates on request', async () => {
    expect((await resolveSupplier(db, CO, 'hetzner'))?.id).toBe(supplierId);
    expect(await resolveSupplier(db, CO, 'Vercel')).toBeNull();
    const v = await resolveSupplier(db, CO, 'Vercel', { create: true });
    expect(v?.name).toBe('Vercel');
    expect((await resolveSupplier(db, CO, v!.id))?.name).toBe('Vercel');
  });

  it('books a foreign-currency bill at the bill rate and the difference at payment to 4900', async () => {
    const b = await createBill(db, CO, { supplierId, currency: 'EUR', rateToBase: '1.10', issuedAt: '2026-08-25T00:00:00Z', lines: [{ description: 'EU thing', unitAmountMinor: 10_000n }] });
    await approveBill(db, CO, b.id);
    expect(await balanceOf(db, CO, '2000')).toBe(11_000n);
    const p = await payBill(db, CO, b.id, { rateToBase: '1.05', reference: 'sepa-1' });
    expect(p.status).toBe('paid');
    expect(await balanceOf(db, CO, '2000')).toBe(0n);
    expect(await balanceOf(db, CO, '4900')).toBe(500n);
  });

  it('a conversion bill is approved without posting and pays down normally', async () => {
    const b = await createBill(db, CO, { supplierId, number: 'OLD-77', conversion: true, issuedAt: '2025-12-15T00:00:00Z', openingPaidMinor: 400n, lines: [{ description: 'From the old system', unitAmountMinor: 1_000n }] });
    const a = await approveBill(db, CO, b.id);
    expect(a.status).toBe('part_paid');
    expect(a.transactionId).toBeNull();
    expect(a.outstandingMinor).toBe('600');
    const before = await balanceOf(db, CO, ACCOUNT.PAYABLES);
    const p = await payBill(db, CO, b.id, { reference: 'old-pay' });
    expect(p.status).toBe('paid');
    expect(await balanceOf(db, CO, '2000')).toBe(before - 600n);
  });
});

describe('documents', () => {
  it('stores a PDF once, links it to a bill, and reads it back', async () => {
    const bill = (await listBills(db, CO))[0]!;
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF').toString('base64');
    const d1 = await addDocument(db, CO, { filename: 'hetzner-aug.pdf', mime: 'application/pdf', contentBase64: pdf, link: { targetKind: 'bill', targetId: bill.id } });
    const d2 = await addDocument(db, CO, { filename: 'again.pdf', mime: 'application/pdf', contentBase64: `data:application/pdf;base64,${pdf}`, link: { targetKind: 'bill', targetId: bill.id } });
    expect(d2.id).toBe(d1.id);
    const docs = await listDocumentsFor(db, CO, 'bill', bill.id);
    expect(docs.length).toBe(1);
    expect(docs[0]!.sizeBytes).toBeGreaterThan(10);
    const back = await readDocument(db, CO, d1.id);
    expect(back?.contentBase64).toBe(pdf);
    await expect(addDocument(db, CO, { filename: 'x.exe', mime: 'application/x-msdownload', contentBase64: pdf })).rejects.toThrow(/not a file type/);
  });
});

describe('invoices with tax and line accounts', () => {
  it('credits income per account and tax to 2100, and the total includes tax', async () => {
    const c = await createCustomer(db, CO, { name: 'Taxed Co' });
    const inv = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', reference: 'PO-9', lines: [
      { description: 'Work', unitAmountMinor: 10_000n, taxMinor: 2_000n },
      { description: 'FX win', unitAmountMinor: 500n, accountCode: ACCOUNT.CURRENCY_GAINS },
    ] });
    expect(inv.subtotalMinor).toBe('10500');
    expect(inv.taxMinor).toBe('2000');
    expect(inv.totalMinor).toBe('12500');
    expect(inv.reference).toBe('PO-9');
    await issueInvoice(db, CO, inv.id, { issuedAt: '2026-08-28T00:00:00Z' });
    expect(await balanceOf(db, CO, '1100')).toBe(12_500n);
    expect(await balanceOf(db, CO, '4000')).toBe(10_000n);
    expect(await balanceOf(db, CO, '2100')).toBe(-274n + 2_000n);
    const paid = await recordPayment(db, CO, inv.id, { amountMinor: 12_500n, reference: 'p' });
    expect(paid.status).toBe('paid');
    expect(await balanceOf(db, CO, '1100')).toBe(0n);
  });

  it('a conversion invoice is issued without posting and honours the opening paid amount', async () => {
    const c = await createCustomer(db, CO, { name: 'Old Client' });
    const inv = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', number: 'INV-2025-118', conversion: true, openingPaidMinor: 2_500n, lines: [{ description: 'Old work', unitAmountMinor: 10_000n }] });
    expect(inv.number).toBe('INV-2025-118');
    const before = await balanceOf(db, CO, ACCOUNT.RECEIVABLES);
    const issued = await issueInvoice(db, CO, inv.id, { issuedAt: '2025-11-30T00:00:00Z' });
    expect(issued.status).toBe('part_paid');
    expect(issued.outstandingMinor).toBe('7500');
    expect(await balanceOf(db, CO, '1100')).toBe(before);
    const paid = await recordPayment(db, CO, inv.id, { amountMinor: 7_500n, reference: 'late' });
    expect(paid.status).toBe('paid');
    expect(await balanceOf(db, CO, '1100')).toBe(before - 7_500n);
    await expect(createInvoice(db, CO, { customerId: c.id, currency: 'USD', number: 'INV-2025-118', lines: [{ description: 'dup', unitAmountMinor: 1n }] })).rejects.toThrow(/already exists/);
  });
});
