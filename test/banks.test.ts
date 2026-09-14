/**
 * Banks and reconciliation, under the plugin rules.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  ACCOUNT,
  applyDecision,
  balanceOf,
  balanceSheet,
  createBankAccount,
  createCustomer,
  createInvoice,
  detectDateOrder,
  getStatementLine,
  importStatementLines,
  issueInvoice,
  listBankAccounts,
  getSettings,
  listRules,
  listStatementLines,
  parseCsvStatement,
  parseMoney,
  parseOfxStatement,
  parseStatement,
  updateSettings,
  position,
  postTransaction,
  propose,
  runReconciliation,
  seedAccounts,
  sweepCosts,
  trialBalance,
} from '../src/core/index.js';
import { paperclipCostSource } from '../src/plugin/cost-source.js';

const CO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const AGENT = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

let db: PluginTestDb;
let bankId: string;
let stripeId: string;

describe('statement reading', () => {
  it('reads money in every common spelling', () => {
    expect(parseMoney('1,234.56')).toBe(123456n);
    expect(parseMoney('-12,00')).toBe(-1200n);
    expect(parseMoney('(12.00)')).toBe(-1200n);
    expect(parseMoney('€ 12.30')).toBe(1230n);
    expect(parseMoney('12.30 DR')).toBe(-1230n);
    expect(parseMoney('1.234,56')).toBe(123456n);
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('abc')).toBeNull();
  });

  it('works out day-first from a column of dates', () => {
    expect(detectDateOrder(['01/09/2026', '15/09/2026'])).toBe('dmy');
    expect(detectDateOrder(['09/01/2026', '09/15/2026'])).toBe('mdy');
    expect(detectDateOrder(['2026-09-01'])).toBe('ymd');
  });

  it('reads a UK-style CSV with Money out and Money in columns', () => {
    const csv = 'Date,Description,Money out,Money in,Balance\n01/09/2026,ANTHROPIC PBC,42.10,,10500.00\n02/09/2026,"RIDGEWAY UNIVERSITY, INV-0035",,6187.50,16687.50\n';
    const p = parseCsvStatement(csv);
    expect(p.lines.length).toBe(2);
    expect(p.lines[0]!.amountMinor).toBe(-4210n);
    expect(p.lines[1]!.amountMinor).toBe(618750n);
    expect(p.lines[1]!.description).toBe('RIDGEWAY UNIVERSITY, INV-0035');
    expect(p.lines[1]!.balanceAfterMinor).toBe(1668750n);
    expect(p.closingBalanceMinor).toBe(1668750n);
    expect(p.reading).toContain('day-month-year');
  });

  it('reads a US-style CSV with a signed Amount column and unfamiliar headers', () => {
    const csv = 'Posted;Details;Amt;Ref\n09/03/2026;GITHUB INC;-4.00;TX1\n09/05/2026;STRIPE PAYOUT;2281.15;po_1Q\n';
    const p = parseStatement(csv, 'export.csv');
    expect(p.lines.map((l) => String(l.amountMinor))).toEqual(['-400', '228115']);
    expect(p.lines[0]!.postedAt.slice(0, 10)).toBe('2026-09-03');
    expect(p.lines[1]!.reference).toBe('po_1Q');
  });

  it('reads OFX', () => {
    const ofx = 'OFXHEADER:100\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><CURDEF>USD<BANKTRANLIST>' +
      '<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20260901120000<TRNAMT>-42.10<FITID>abc1<NAME>ANTHROPIC PBC<MEMO>card</STMTTRN>' +
      '<STMTTRN><TRNTYPE>CREDIT<DTPOSTED>20260902<TRNAMT>6187.50<FITID>abc2<NAME>RIDGEWAY UNIVERSITY</STMTTRN>' +
      '</BANKTRANLIST><LEDGERBAL><BALAMT>16687.50</LEDGERBAL></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>';
    const p = parseOfxStatement(ofx);
    expect(p.lines.length).toBe(2);
    expect(p.lines[0]!.externalId).toBe('abc1');
    expect(p.currency).toBe('USD');
    expect(p.closingBalanceMinor).toBe(1668750n);
  });
});

describe('bank accounts and lines', () => {
  beforeAll(async () => {
    db = await openPluginTestDb();
    await seedAccounts(db, CO, 'USD', { version: 1 });
  });
  afterAll(async () => {
    await db.close();
  });

  it('creates accounts as sub-accounts of Treasury', async () => {
    const bank = await createBankAccount(db, CO, { name: 'Mercury Checking', kind: 'bank', currency: 'USD' });
    const stripe = await createBankAccount(db, CO, { name: 'Stripe', kind: 'stripe', currency: 'USD' });
    bankId = bank.id;
    stripeId = stripe.id;
    expect(bank.accountCode).toBe('1001');
    expect(stripe.accountCode).toBe('1002');
    expect(stripe.feed).toBe('stripe');
    const all = await listBankAccounts(db, CO);
    expect(all.map((b) => b.name)).toEqual(['Mercury Checking', 'Stripe']);
    // the position still reports one treasury figure
    expect((await position(db, CO)).treasuryMinor).toBe('0');
  });

  it('imports lines once, however many times the file is uploaded', async () => {
    const csv = 'Date,Description,Amount\n2026-09-01,ANTHROPIC PBC,-42.10\n2026-09-03,GITHUB INC,-4.00\n2026-09-06,TFR 3391 J CHARLESWORTH,5000.00\n';
    const p = parseStatement(csv);
    const first = await importStatementLines(db, CO, bankId, p.lines);
    expect(first.imported).toBe(3);
    const again = await importStatementLines(db, CO, bankId, p.lines);
    expect(again.imported).toBe(0);
    expect(again.duplicates).toBe(3);
    expect((await listStatementLines(db, CO, bankId)).length).toBe(3);
  });

  it('batch-matches a provider charge to the swept cost events that sum to it', async () => {
    for (const cents of [1000, 2000, 1210]) {
      await db.raw.query(
        `INSERT INTO public.cost_events (company_id, agent_id, provider, model, billing_type, cost_status, cost_cents, occurred_at, created_at)
         VALUES ($1, $2, 'anthropic', 'claude-sonnet-5', 'metered_api', 'reported', $3, '2026-08-20T00:00:00Z', '2026-08-20T00:00:00Z')`,
        [CO, AGENT, cents],
      );
    }
    await sweepCosts(db, paperclipCostSource(db.sql), CO, { currency: 'USD' });
    const line = (await listStatementLines(db, CO, bankId)).find((l) => l.description.includes('ANTHROPIC'))!;
    const p = await propose(db, CO, line);
    expect(p.kind).toBe('batch');
    expect(p.confidence).toBe(96);
    expect(p.transactionIds?.length).toBe(3);
    expect(p.reason).toContain('3 swept cost events');
    // accept it: the money moves from Treasury to the bank sub-account, total unchanged
    const before = (await position(db, CO)).treasuryMinor;
    await applyDecision(db, CO, line.id, { kind: 'match', transactionIds: p.transactionIds! });
    expect((await getStatementLine(db, CO, line.id))!.status).toBe('matched');
    expect(await balanceOf(db, CO, '1001')).toBe(-4210n);
    expect((await position(db, CO)).treasuryMinor).toBe(before);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
    // the events cannot be matched twice
    const p2 = await propose(db, CO, { ...line, id: line.id });
    expect(p2.kind).not.toBe('batch');
  });

  it('codes an unknown payee by keyword, and confirming writes a rule', async () => {
    const gh = (await listStatementLines(db, CO, bankId)).find((l) => l.description.includes('GITHUB'))!;
    const p = await propose(db, CO, gh);
    expect(p.kind).toBe('create');
    expect(p.accountCode).toBe('5100');
    expect(p.confidence).toBe(62);
    await applyDecision(db, CO, gh.id, { kind: 'create', accountCode: ACCOUNT.TOOLS_AND_APIS });
    const rules = await listRules(db, CO);
    expect(rules.length).toBe(1);
    expect(rules[0]!.payeeContains).toBe('github inc');
    expect(rules[0]!.accountCode).toBe('5100');
    expect(await balanceOf(db, CO, '5100')).toBe(400n);
    // next month the rule fires with a higher confidence
    await importStatementLines(db, CO, bankId, parseStatement('Date,Description,Amount\n2026-10-03,GITHUB INC,-4.00\n').lines);
    const gh2 = (await listStatementLines(db, CO, bankId, { status: 'unreconciled' })).find((l) => l.description.includes('GITHUB'))!;
    const p2 = await propose(db, CO, gh2);
    expect(p2.kind).toBe('create');
    expect(p2.ruleId).toBe(rules[0]!.id);
    expect(p2.confidence).toBeGreaterThanOrEqual(86);
  });

  it('asks about money in it cannot explain, with the likely answers ready', async () => {
    const tfr = (await listStatementLines(db, CO, bankId)).find((l) => l.description.includes('TFR'))!;
    const p = await propose(db, CO, tfr);
    expect(p.kind).toBe('ask');
    expect(p.options?.map((o) => o.label)).toContain('Funding from the owner');
    await applyDecision(db, CO, tfr.id, p.options![0]!.decision);
    expect(await balanceOf(db, CO, '3000')).toBe(500000n);
    expect(await balanceOf(db, CO, '1001')).toBe(500000n - 4210n - 400n);
  });

  it('matches a customer payment to the open invoice and records it against the bank', async () => {
    const c = await createCustomer(db, CO, { name: 'Ridgeway University' });
    const inv = await createInvoice(db, CO, { customerId: c.id, currency: 'USD', lines: [{ description: 'Course', unitAmountMinor: 618750 }] });
    await issueInvoice(db, CO, inv.id, { issuedAt: '2026-08-29T00:00:00Z' });
    await importStatementLines(db, CO, bankId, parseStatement('Date,Description,Amount,Reference\n2026-09-02,RIDGEWAY UNIVERSITY,6187.50,INV-0001\n').lines);
    const line = (await listStatementLines(db, CO, bankId, { status: 'unreconciled' })).find((l) => l.description.includes('RIDGEWAY'))!;
    const p = await propose(db, CO, line);
    expect(p.kind).toBe('create');
    expect(p.confidence).toBe(98);
    expect(p.invoiceId).toBe(inv.id);
    await applyDecision(db, CO, line.id, { kind: 'create', accountCode: ACCOUNT.RECEIVABLES, invoiceId: inv.id });
    expect(await balanceOf(db, CO, '1100')).toBe(0n);
    expect(await balanceOf(db, CO, '1001')).toBe(500000n - 4210n - 400n + 618750n);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
  });

  it('recognises a transfer between two of our accounts and closes both lines', async () => {
    await importStatementLines(db, CO, stripeId, parseStatement('Date,Description,Amount,Reference\n2026-09-04,PAYOUT,-2281.15,po_1Q\n').lines);
    await importStatementLines(db, CO, bankId, parseStatement('Date,Description,Amount,Reference\n2026-09-05,STRIPE PAYOUT,2281.15,po_1Q\n').lines);
    const bankLine = (await listStatementLines(db, CO, bankId, { status: 'unreconciled' })).find((l) => l.description.includes('STRIPE'))!;
    const p = await propose(db, CO, bankLine);
    expect(p.kind).toBe('transfer');
    expect(p.confidence).toBe(99);
    expect(p.otherBankAccountId).toBe(stripeId);
    await applyDecision(db, CO, bankLine.id, { kind: 'transfer', otherBankAccountId: stripeId, otherLineId: p.otherLineId! });
    const stripeLines = await listStatementLines(db, CO, stripeId);
    expect(stripeLines[0]!.status).toBe('transferred');
    expect(await balanceOf(db, CO, '1002')).toBe(-228115n);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
  });

  it('matches a manually recorded funding to its statement line', async () => {
    await postTransaction(db, { companyId: CO, occurredAt: '2026-09-10T00:00:00Z', sourcePlatform: 'manual', sourceKind: 'funding', sourceRef: 'wire-77', currency: 'USD', description: 'Funding · wire-77',
      entries: [{ accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 100000n }, { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 100000n }] });
    await importStatementLines(db, CO, bankId, parseStatement('Date,Description,Amount,Reference\n2026-09-11,INCOMING WIRE,1000.00,wire-77\n').lines);
    const line = (await listStatementLines(db, CO, bankId, { status: 'unreconciled' })).find((l) => l.description.includes('WIRE'))!;
    const p = await propose(db, CO, line);
    expect(p.kind).toBe('match');
    expect(p.confidence).toBe(97);
  });

  it('a run posts everything above the threshold and leaves the rest, then the sheet still balances', async () => {
    await importStatementLines(db, CO, bankId, parseStatement('Date,Description,Amount\n2026-09-12,GITHUB INC,-4.00\n2026-09-12,MYSTERY VENDOR,-9.99\n').lines);
    const r = await runReconciliation(db, CO, bankId, { threshold: 85, by: 'test' });
    expect(r.linesSeen).toBeGreaterThanOrEqual(4);
    expect(r.autoPosted).toBeGreaterThanOrEqual(3); // rule (github twice), funding match
    const left = await listStatementLines(db, CO, bankId, { status: 'unreconciled' });
    expect(left.map((l) => l.description)).toEqual(['MYSTERY VENDOR']);
    expect(left[0]!.proposal?.kind).toBe('ask');
    const bs = await balanceSheet(db, CO);
    expect(bs.balances).toBe(true);
    expect((await trialBalance(db, CO)).netMinor).toBe(0n);
  });

  it('a company that has turned auto-posting off gets the proposals and none of the postings', async () => {
    // The nightly job used to post at 90% for every company on the box, which
    // is a policy about somebody else's books. Off means off: the matcher still
    // runs, so the queue is ready in the morning, but nothing reaches the books
    // without a person.
    await importStatementLines(db, CO, bankId, parseStatement('Date,Description,Amount\n2026-09-20,GITHUB INC,-7.00\n').lines);
    const before = await balanceOf(db, CO, ACCOUNT.TOOLS_AND_APIS);

    const r = await runReconciliation(db, CO, bankId, { threshold: 90, by: 'nightly', autoPost: false });
    expect(r.autoPosted).toBe(0);
    expect(r.leftForReview).toBeGreaterThan(0);
    expect(await balanceOf(db, CO, '5100')).toBe(before);

    const line = (await listStatementLines(db, CO, bankId, { status: 'unreconciled' })).find((l) => l.description.includes('GITHUB'))!;
    expect(line.proposal, 'the suggestion is still made, so the queue is useful in the morning').toBeTruthy();
    expect(line.proposal!.kind).toBe('create');
  });

  it('the threshold and the switch are the company\u2019s own, and a silly one is refused', async () => {
    const off = await updateSettings(db, CO, { autoReconcile: false, autoReconcileThreshold: 75 });
    expect(off.autoReconcile).toBe(false);
    expect(off.autoReconcileThreshold).toBe(75);
    expect((await getSettings(db, CO)).autoReconcileThreshold).toBe(75);

    // A threshold is a licence to post to somebody's books unattended, so it is
    // clamped rather than trusted.
    expect((await updateSettings(db, CO, { autoReconcileThreshold: 5 })).autoReconcileThreshold).toBe(50);
    expect((await updateSettings(db, CO, { autoReconcileThreshold: 9000 })).autoReconcileThreshold).toBe(100);
    expect((await updateSettings(db, CO, { autoReconcileThreshold: Number.NaN })).autoReconcileThreshold).toBe(90);

    // And a company that never opens the screen keeps exactly what the job did
    // before any of this existed.
    const fresh = await getSettings(db, 'co-never-touched');
    expect(fresh.autoReconcile).toBe(true);
    expect(fresh.autoReconcileThreshold).toBe(90);
  });
});
