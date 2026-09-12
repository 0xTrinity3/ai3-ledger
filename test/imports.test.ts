/**
 * Imports from another system: chart, trial balance under the conversion
 * rule, invoices and bills one row per line. Plugin rules throughout.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT,
  balanceOf,
  balanceSheet,
  getSettings,
  importChart,
  importDocuments,
  importTrialBalance,
  inferAccountType,
  listBills,
  listInvoices,
  openingMoment,
  parseChartCsv,
  parseDocumentsCsv,
  parseTrialBalanceCsv,
  previewDocuments,
  profitAndLoss,
  seedAccounts,
  trialBalanceReport,
  undoTrialBalance,
} from '../src/core/index.js';

const CO = 'c0c0c0c0-c0c0-4c0c-8c0c-c0c0c0c0c0c0';
let db: PluginTestDb;

const CHART = `Code,Name,Type
1200,Prepayments,Current Asset
2100,VAT,Current Liability
6100,Marketing,Expense
4100,Consulting income,Revenue
`;

const TB = `Account,Debit,Credit
1000 - Treasury,"12,500.00",
1100 - Receivables,"3,000.00",
1200 - Prepayments,400.00,
2000 - Payables,,"1,250.00"
2100 - VAT,,150.00
3000 - Contributed funds,,"10,000.00"
4100 - Consulting income,,"9,800.00"
6100 - Marketing,"5,300.00",
Total,"21,200.00","21,200.00"
`;

const INVOICES = `ContactName,EmailAddress,InvoiceNumber,InvoiceDate,DueDate,Description,Quantity,UnitAmount,AccountCode,TaxAmount,Status,AmountPaid
Acme Ltd,ap@acme.example,INV-2025-41,15/12/2025,14/01/2026,December retainer,1,2000.00,4100,0.00,AUTHORISED,0.00
Beta Co,,INV-2025-42,20/12/2025,19/01/2026,Workshop,2,500.00,4100,0.00,AUTHORISED,0.00
Beta Co,,INV-2025-40,01/11/2025,01/12/2025,October work,1,800.00,4100,0.00,PAID,800.00
Acme Ltd,ap@acme.example,INV-2026-01,10/01/2026,09/02/2026,January retainer,1,2000.00,4100,400.00,AUTHORISED,0.00
Acme Ltd,ap@acme.example,INV-2026-01,10/01/2026,09/02/2026,Extra hours,3,100.00,4100,60.00,AUTHORISED,0.00
Gamma,,INV-2026-02,20/01/2026,19/02/2026,Quick fix,1,150.00,,0.00,PAID,150.00
Gamma,,INV-2026-03,21/01/2026,20/02/2026,Voided thing,1,999.00,,0.00,VOIDED,0.00
`;

const BILLS = `ContactName,InvoiceNumber,InvoiceDate,DueDate,Description,Quantity,UnitAmount,AccountCode,TaxAmount,Status
Hetzner,R-1001,28/12/2025,11/01/2026,Servers December,1,1250.00,6100,0.00,AUTHORISED
Vercel,V-77,05/01/2026,05/02/2026,Hosting January,1,20.00,,4.00,PAID
Hetzner,R-1002,28/01/2026,11/02/2026,Servers January,1,1250.00,6100,0.00,AUTHORISED
`;

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
});

afterAll(async () => {
  await db.close();
});

describe('readers', () => {
  it('reads a chart with types from another system and infers the rest', () => {
    const c = parseChartCsv(CHART);
    expect(c.lines.map((l) => [l.code, l.type, l.guessed])).toEqual([['1200', 'asset', false], ['2100', 'liability', false], ['6100', 'expense', false], ['4100', 'income', false]]);
    expect(inferAccountType({ code: '1500', name: 'Office equipment' })).toEqual({ type: 'asset', guessed: true });
    expect(inferAccountType({ code: '2300', name: 'Director loan' })).toEqual({ type: 'liability', guessed: true });
    expect(inferAccountType({ name: 'Bank fees' })).toEqual({ type: 'asset', guessed: true }); // "bank" wins; the preview lets a person fix it
    expect(inferAccountType({ code: '7000', name: 'Rent' })).toEqual({ type: 'expense', guessed: true });
  });

  it("reads Xero's trial balance shape, splitting code and name and dropping the total row", () => {
    const tb = parseTrialBalanceCsv(TB);
    expect(tb.lines.length).toBe(8);
    expect(tb.lines[0]).toMatchObject({ code: '1000', name: 'Treasury', debitMinor: '1250000', creditMinor: '0' });
    expect(tb.lines.find((l) => l.code === '2000')).toMatchObject({ creditMinor: '125000' });
    expect(tb.balances).toBe(true);
    expect(tb.debitMinor).toBe('2120000');
  });

  it('reads invoices one row per line and groups them by number', () => {
    const p = parseDocumentsCsv(INVOICES, 'invoice');
    expect(p.docs.length).toBe(6);
    const jan = p.docs.find((d) => d.number === 'INV-2026-01')!;
    expect(jan.lines.length).toBe(2);
    expect(jan.subtotalMinor).toBe('230000');
    expect(jan.taxMinor).toBe('46000');
    expect(jan.totalMinor).toBe('276000');
    expect(jan.date).toBe('2026-01-10T12:00:00.000Z');
    expect(jan.lines[0]!.accountCode).toBe('4100');
    expect(p.docs.find((d) => d.number === 'INV-2025-40')!.paidMinor).toBe('80000');
    expect(p.docs.find((d) => d.number === 'INV-2026-02')!.paidMinor).toBe('15000');
    expect(p.warnings.join(' ')).toMatch(/1 void/);
  });
});

describe('trial balance import', () => {
  it('creates missing accounts, posts the opening balances the instant before the conversion date, and remembers the date', async () => {
    const chart = parseChartCsv(CHART);
    const r0 = await importChart(db, CO, chart.lines);
    expect(r0.added).toBe(3); // 2100 already seeded
    const tb = parseTrialBalanceCsv(TB);
    await expect(importTrialBalance(db, CO, { conversionDate: '2026-02-30', lines: tb.lines })).rejects.toThrow(/date/);
    const r = await importTrialBalance(db, CO, { conversionDate: '2026-01-01', lines: tb.lines, createdBy: 'tester' });
    expect(r.postedAt).toBe('2025-12-31T23:59:59.999Z');
    expect(openingMoment('2026-01-01')).toBe(r.postedAt);
    expect(r.accountsAdded).toBe(0);
    expect((await getSettings(db, CO)).conversionDate).toBe('2026-01-01');
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(1_250_000n);
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(300_000n);
    expect(await balanceOf(db, CO, ACCOUNT.PAYABLES)).toBe(125_000n);
    // a P&L from the conversion date is clean; the balance sheet at the conversion date carries everything
    const pnl = await profitAndLoss(db, CO, { from: '2026-01-01T00:00:00Z', to: '2026-01-31T23:59:59Z' });
    expect(pnl.incomeMinor).toBe('0');
    const bs = await balanceSheet(db, CO, '2026-01-01T00:00:00Z');
    expect(bs.balances).toBe(true);
    expect(bs.assets.totalMinor).toBe('1590000');
    const report = await trialBalanceReport(db, CO, '2026-01-01T00:00:00Z');
    expect(report.balances).toBe(true);
    expect(report.lines.find((l) => l.code === '6100')?.debitMinor).toBe('530000');
  });

  it('refuses a second import while one stands, and plugs an unbalanced one only when asked', async () => {
    const tb = parseTrialBalanceCsv(TB);
    await expect(importTrialBalance(db, CO, { conversionDate: '2026-01-01', lines: tb.lines })).rejects.toThrow(/already imported/);
    const undone = await undoTrialBalance(db, CO, { createdBy: 'tester' });
    expect(undone?.reversalId).toBeTruthy();
    expect(await balanceOf(db, CO, ACCOUNT.TREASURY)).toBe(0n);
    const lopsided = tb.lines.map((l) => (l.code === '6100' ? { ...l, debitMinor: '520000' } : l));
    await expect(importTrialBalance(db, CO, { conversionDate: '2026-01-01', lines: lopsided })).rejects.toThrow(/does not balance/);
    const r = await importTrialBalance(db, CO, { conversionDate: '2026-01-01', lines: lopsided, plugToRetainedEarnings: true });
    expect(r.plugMinor).toBe('-10000');
    expect(await balanceOf(db, CO, ACCOUNT.RETAINED_EARNINGS)).toBe(-10_000n);
    expect((await trialBalanceReport(db, CO)).balances).toBe(true);
  });
});

describe('document import under the conversion rule', () => {
  it('previews: pre-conversion unpaid invoices are checked against Receivables, the rest will post', async () => {
    const parsed = parseDocumentsCsv(INVOICES, 'invoice');
    const p = await previewDocuments(db, CO, parsed);
    expect(p.conversionDate).toBe('2026-01-01');
    expect(p.rows.filter((r) => r.preConversion).length).toBe(3);
    expect(p.preConversionOutstandingMinor).toBe('300000'); // 2000 + 1000 unpaid; the paid October one adds nothing
    expect(p.controlMinor).toBe('300000');
    expect(p.differenceMinor).toBe('0');
    expect(p.skipped).toBe(1);
    expect(p.postConversionTotalMinor).toBe('291000'); // 2760 + 150
  });

  it('imports invoices: records before the date, postings after, payments where marked', async () => {
    const parsed = parseDocumentsCsv(INVOICES, 'invoice');
    const before = await balanceOf(db, CO, ACCOUNT.RECEIVABLES);
    const income4100 = await balanceOf(db, CO, '4100');
    const r = await importDocuments(db, CO, parsed, { createdBy: 'tester' });
    expect(r.failed).toEqual([]);
    expect(r.created).toBe(5);
    expect(r.skipped).toBe(1);
    const all = await listInvoices(db, CO, { limit: 100 });
    expect(all.length).toBe(5);
    const old = all.find((i) => i.number === 'INV-2025-41')!;
    expect(old.status).toBe('issued');
    expect(old.conversion).toBe(true);
    expect(old.outstandingMinor).toBe('200000');
    expect(all.find((i) => i.number === 'INV-2025-40')!.status).toBe('paid');
    const jan = all.find((i) => i.number === 'INV-2026-01')!;
    expect(jan.status).toBe('issued');
    expect(jan.totalMinor).toBe('276000');
    expect(all.find((i) => i.number === 'INV-2026-02')!.status).toBe('paid');
    // receivables: opening 3000 + Jan 2760 + 150 - 150 paid
    expect(await balanceOf(db, CO, ACCOUNT.RECEIVABLES)).toBe(before + 276_000n);
    expect(await balanceOf(db, CO, '4100')).toBe(income4100 + 230_000n);
    expect(await balanceOf(db, CO, ACCOUNT.SERVICE_INCOME)).toBe(15_000n); // Gamma had no account column value
    expect(await balanceOf(db, CO, ACCOUNT.TAX_PAYABLE)).toBe(15_000n + 46_000n); // VAT from the trial balance plus January's tax
    // a second run skips everything as duplicates
    const again = await importDocuments(db, CO, parsed, { createdBy: 'tester' });
    expect(again.created).toBe(0);
    expect(again.skipped).toBe(6);
  });

  it('imports bills the same way, creating suppliers and paying what was paid', async () => {
    const parsed = parseDocumentsCsv(BILLS, 'bill');
    const p = await previewDocuments(db, CO, parsed);
    expect(p.preConversionOutstandingMinor).toBe('125000');
    expect(p.controlMinor).toBe('125000');
    const before = await balanceOf(db, CO, ACCOUNT.PAYABLES);
    const r = await importDocuments(db, CO, parsed, { createdBy: 'tester', defaultAccountCode: ACCOUNT.TOOLS_AND_APIS });
    expect(r.failed).toEqual([]);
    expect(r.created).toBe(3);
    const bills = await listBills(db, CO, { withLines: true });
    expect(bills.length).toBe(3);
    const dec = bills.find((b) => b.number === 'R-1001')!;
    expect(dec.conversion).toBe(true);
    expect(dec.status).toBe('approved');
    expect(dec.transactionId).toBeNull();
    const vercel = bills.find((b) => b.number === 'V-77')!;
    expect(vercel.status).toBe('paid');
    expect(vercel.totalMinor).toBe('2400');
    expect(vercel.lines[0]!.accountCode).toBe(ACCOUNT.TOOLS_AND_APIS);
    expect(await balanceOf(db, CO, ACCOUNT.PAYABLES)).toBe(before + 125_000n); // January Hetzner posted; Vercel posted and paid
    expect(await balanceOf(db, CO, '6100')).toBe(520_000n + 125_000n);
    expect((await trialBalanceReport(db, CO)).balances).toBe(true);
  });
});
