/**
 * Agent tools for the books proper: journals, the trial balance, the chart,
 * what sits behind a figure, suppliers and bills. Same conventions as
 * tools.ts: amounts in major units at the boundary, the host supplies the
 * company, no permission gate by decision.
 */
import type { PluginToolDeclaration, ToolResult, ToolRunContext } from '@paperclipai/plugin-sdk';
import {
  LedgerError,
  accountBalances,
  approveBill,
  createBill,
  createJournal,
  findBillByNumber,
  getBill,
  getJournal,
  getTransaction,
  listBills,
  listEntries,
  listJournals,
  listSuppliers,
  payBill,
  resolveSupplier,
  trialBalanceReport,
  voidBill,
  voidJournal,
  type AccountType,
  type Bill,
  type BillStatus,
  type EntryFilter,
  type Journal,
  type JournalStatus,
  type LedgerDb,
  type SourceKind,
} from '../core/index.js';
import { describeSource } from './sources.js';

const AMOUNT = { type: 'string', description: 'Amount in major units with up to two decimals, e.g. "1250.00".' };
const DATE = { type: 'string', description: 'A date, YYYY-MM-DD. Defaults to today.' };

const MAJOR = /^-?\d{1,15}(\.\d{1,2})?$/;
function majorToMinor(v: unknown, what = 'amount'): bigint {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!MAJOR.test(s)) throw new LedgerError(`${what} must be a number with up to two decimals, like 1250.00`, 'invalid');
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -minor : minor;
}
function minorToMajor(v: string | bigint): string {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  return `${neg ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
}
function money(minor: string | bigint, currency: string | null): string {
  return `${minorToMajor(minor)} ${currency ?? ''}`.trim();
}
function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function obj(params: unknown): Record<string, unknown> {
  return params && typeof params === 'object' ? (params as Record<string, unknown>) : {};
}

export const BOOKS_TOOL_DECLARATIONS: PluginToolDeclaration[] = [
  {
    name: 'chart-of-accounts',
    displayName: 'Chart of accounts',
    description: 'Every account in the books with its code, name, type and current balance. Use the codes when posting a journal or choosing where a bill line goes.',
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'post-journal',
    displayName: 'Post a manual journal',
    description: 'Post a balanced manual journal: at least two lines, each a debit or a credit to an account code, debits equal to credits. Use it for accruals, corrections, prepayments and anything no other tool covers. Pass draft: true to leave it unposted for a person to review.',
    parametersSchema: {
      type: 'object',
      properties: {
        date: DATE,
        narration: { type: 'string', description: 'Why this journal exists. Shows on every report line it produces.' },
        lines: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            properties: {
              account: { type: 'string', description: 'Account code, e.g. 5200.' },
              debit: AMOUNT,
              credit: AMOUNT,
              description: { type: 'string' },
            },
            required: ['account'],
            additionalProperties: false,
          },
        },
        draft: { type: 'boolean', description: 'Save without posting. Default false.' },
      },
      required: ['lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'journals',
    displayName: 'List journals',
    description: 'Manual journals, newest first, with status (draft, posted, voided), date, narration and totals.',
    parametersSchema: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'posted', 'voided'] }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
  },
  {
    name: 'void-journal',
    displayName: 'Void a journal',
    description: 'Reverse a posted journal so it drops out of every report. The journal and its reversal both stay in the books. Cannot be undone.',
    parametersSchema: { type: 'object', properties: { journal: { type: 'string', description: 'Journal id or number, e.g. JNL-0003.' }, reason: { type: 'string' } }, required: ['journal'], additionalProperties: false },
  },
  {
    name: 'trial-balance',
    displayName: 'Trial balance',
    description: 'Every account with a balance at a date, debit balances in one column and credit balances in the other, and whether the two agree. Pass from to see only the movements in a window.',
    parametersSchema: { type: 'object', properties: { asOf: DATE, from: { type: 'string', description: 'Start of a window, YYYY-MM-DD. Omit for balances to date.' } }, additionalProperties: false },
  },
  {
    name: 'entries',
    displayName: 'What is behind a figure',
    description: 'The posted entries behind a report figure: filter by account code or account type, a date window, an agent, and the kind of source (cost_sweep, invoice, payment, bill, journal, funding, reversal, conversion). Each row names the transaction it belongs to; pass that id to `transaction` for the full story.',
    parametersSchema: {
      type: 'object',
      properties: {
        account: { type: 'string', description: 'Account code, e.g. 5000.' },
        type: { type: 'string', enum: ['asset', 'liability', 'equity', 'income', 'expense'] },
        from: { type: 'string', description: 'YYYY-MM-DD' },
        to: { type: 'string', description: 'YYYY-MM-DD' },
        agent: { type: 'string', description: 'Only entries attributed to this agent id.' },
        sourceKind: { type: 'string', enum: ['cost_sweep', 'funding', 'invoice', 'payment', 'manual', 'reversal', 'journal', 'bill', 'conversion'] },
        limit: { type: 'integer', minimum: 1, maximum: 1000 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'transaction',
    displayName: 'One transaction',
    description: 'One transaction in full: every debit and credit, what caused it (an invoice, a bill and its attached documents, a bank line, a journal, or the Paperclip cost event with its agent and run), and whether it was reversed.',
    parametersSchema: { type: 'object', properties: { transactionId: { type: 'string' } }, required: ['transactionId'], additionalProperties: false },
  },
  {
    name: 'suppliers',
    displayName: 'List suppliers',
    description: 'Suppliers the company has bills from, with ids, emails and the expense account their bills default to.',
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'bills',
    displayName: 'List bills',
    description: 'Bills received from suppliers, newest first, with status (draft, approved, part_paid, paid, void), totals, what is still owed and days overdue.',
    parametersSchema: { type: 'object', properties: { status: { type: 'string', enum: ['draft', 'approved', 'part_paid', 'paid', 'void'] }, overdueOnly: { type: 'boolean' }, limit: { type: 'integer', minimum: 1, maximum: 200 } }, additionalProperties: false },
  },
  {
    name: 'bill',
    displayName: 'Bill detail',
    description: 'One bill in full: lines with their expense accounts, tax, payments made, and the supplier.',
    parametersSchema: { type: 'object', properties: { bill: { type: 'string', description: 'Bill id or number, e.g. BILL-0004.' } }, required: ['bill'], additionalProperties: false },
  },
  {
    name: 'create-bill',
    displayName: 'Record a supplier bill',
    description: 'Record a bill the company owes a supplier. Names the supplier (created if new), lists the lines with the expense account each belongs to, and by default approves it, which books the expense and the payable. Amounts are in the bill currency.',
    parametersSchema: {
      type: 'object',
      properties: {
        supplier: { type: 'string', description: 'Supplier name (created if new) or id.' },
        supplierEmail: { type: 'string' },
        reference: { type: 'string', description: "The supplier's own invoice number." },
        date: DATE,
        dueInDays: { type: 'integer', minimum: 0, maximum: 365, description: 'Defaults to 30.' },
        currency: { type: 'string', description: 'Defaults to the company base currency.' },
        rateToBase: { type: 'string', description: 'Base units per one unit of the bill currency; only for a non-base currency.' },
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: {
              description: { type: 'string' },
              quantity: { type: 'string', description: 'Defaults to 1.' },
              unitAmount: AMOUNT,
              tax: { type: 'string', description: 'Tax on the line in major units. Defaults to none.' },
              account: { type: 'string', description: 'Expense account code. Defaults to the supplier default, then 5900 Other operating.' },
            },
            required: ['description', 'unitAmount'],
            additionalProperties: false,
          },
        },
        notes: { type: 'string' },
        approve: { type: 'boolean', description: 'Approve now (default true). false keeps a draft.' },
      },
      required: ['supplier', 'lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'pay-bill',
    displayName: 'Record a bill payment',
    description: 'Record that a bill was paid, in full by default, from Treasury or a named bank account code. Posts debit Payables / credit the cash account.',
    parametersSchema: {
      type: 'object',
      properties: {
        bill: { type: 'string', description: 'Bill id or number.' },
        amount: { type: 'string', description: 'Defaults to everything outstanding.' },
        date: DATE,
        reference: { type: 'string', description: 'A payment reference; the same reference twice is ignored.' },
        fromAccount: { type: 'string', description: 'Cash account code (a bank account under Treasury). Defaults to 1000.' },
      },
      required: ['bill'],
      additionalProperties: false,
    },
  },
  {
    name: 'void-bill',
    displayName: 'Void a bill',
    description: 'Cancel a bill recorded in error. A draft is voided; an approved bill with nothing paid is reversed. Cannot be undone.',
    parametersSchema: { type: 'object', properties: { bill: { type: 'string' }, reason: { type: 'string' } }, required: ['bill'], additionalProperties: false },
  },
];

function journalSummary(j: Journal): Record<string, unknown> {
  return { journalId: j.id, number: j.number, status: j.status, date: day(j.occurredAt), narration: j.narration, total: minorToMajor(j.debitMinor), transactionId: j.transactionId, reversalId: j.reversalId, lines: j.lines.map((l) => ({ account: l.accountCode, name: l.accountName, [l.direction]: minorToMajor(l.amountMinor), description: l.description })) };
}

function overdueDays(b: Bill, now = new Date()): number {
  if (!b.dueAt || !(b.status === 'approved' || b.status === 'part_paid')) return 0;
  const d = Math.floor((now.getTime() - Date.parse(b.dueAt)) / 86_400_000);
  return d > 0 ? d : 0;
}

function billSummary(b: Bill): Record<string, unknown> {
  return { billId: b.id, number: b.number, reference: b.reference, status: b.status, supplier: b.supplierName, currency: b.currency, subtotal: minorToMajor(b.subtotalMinor), tax: minorToMajor(b.taxMinor), total: minorToMajor(b.totalMinor), paid: minorToMajor(b.paidMinor), outstanding: minorToMajor(b.outstandingMinor), date: day(b.issuedAt), dueAt: day(b.dueAt), overdueDays: overdueDays(b), transactionId: b.transactionId };
}

async function findJournal(db: LedgerDb, companyId: string, ref: unknown): Promise<Journal> {
  const r = str(ref);
  if (!r) throw new LedgerError('journal is required', 'invalid');
  if (/^[0-9a-f-]{36}$/i.test(r)) {
    const j = await getJournal(db, companyId, r);
    if (j) return j;
  }
  const hit = (await listJournals(db, companyId, { limit: 1000 })).find((j) => j.number.toUpperCase() === r.toUpperCase());
  if (!hit) throw new LedgerError(`no journal ${r}`, 'invalid');
  return hit;
}

async function findBill(db: LedgerDb, companyId: string, ref: unknown): Promise<Bill> {
  const r = str(ref);
  if (!r) throw new LedgerError('bill is required', 'invalid');
  if (/^[0-9a-f-]{36}$/i.test(r)) {
    const b = await getBill(db, companyId, r);
    if (b) return b;
  }
  const b = await findBillByNumber(db, companyId, r);
  if (!b) throw new LedgerError(`no bill ${r}`, 'invalid');
  return b;
}

export function isBooksTool(name: string): boolean {
  return BOOKS_TOOL_DECLARATIONS.some((t) => t.name === name);
}

export async function runBooksTool(db: LedgerDb, name: string, rawParams: unknown, run: ToolRunContext): Promise<ToolResult> {
  const p = obj(rawParams);
  const companyId = run.companyId;
  const by = `agent:${run.agentId}`;
  try {
    switch (name) {
      case 'chart-of-accounts': {
        const rows = await accountBalances(db, companyId);
        return { content: `${rows.length} accounts.`, data: { accounts: rows.map((a) => ({ code: a.code, name: a.name, type: a.type, balance: minorToMajor(a.balanceMinor) })) } };
      }
      case 'post-journal': {
        const lines = (Array.isArray(p['lines']) ? (p['lines'] as Array<Record<string, unknown>>) : []).map((l, i) => {
          const debit = str(l['debit']);
          const credit = str(l['credit']);
          if ((debit && credit) || (!debit && !credit)) throw new LedgerError(`line ${i + 1} needs exactly one of debit or credit`, 'invalid');
          return { accountCode: String(l['account'] ?? ''), direction: (debit ? 'debit' : 'credit') as 'debit' | 'credit', amountMinor: majorToMinor(debit ?? credit, `line ${i + 1}`), description: str(l['description']) ?? null, subject: { agent: run.agentId } };
        });
        const j = await createJournal(db, companyId, { occurredAt: str(p['date']) ? `${str(p['date'])}T12:00:00.000Z` : new Date(), narration: str(p['narration']) ?? null, lines, createdBy: by, post: p['draft'] !== true });
        return { content: `${j.number} ${j.status}: ${money(j.debitMinor, j.currency)} across ${j.lines.length} lines${j.narration ? ` · ${j.narration}` : ''}.`, data: journalSummary(j) };
      }
      case 'journals': {
        const status = str(p['status']) as JournalStatus | undefined;
        const list = await listJournals(db, companyId, { ...(status ? { status } : {}), limit: Math.min(Number(p['limit'] ?? 50) || 50, 200) });
        return { content: list.length === 0 ? 'No journals.' : `${list.length} journal(s).`, data: { journals: list.map(journalSummary) } };
      }
      case 'void-journal': {
        const j = await findJournal(db, companyId, p['journal']);
        const v = await voidJournal(db, companyId, j.id, { createdBy: by, ...(str(p['reason']) ? { reason: str(p['reason'])! } : {}) });
        return { content: `${v.number} voided; reversal ${v.reversalId}.`, data: journalSummary(v) };
      }
      case 'trial-balance': {
        const asOf = str(p['asOf']) ? `${str(p['asOf'])}T23:59:59.999Z` : new Date();
        const from = str(p['from']) ? `${str(p['from'])}T00:00:00.000Z` : undefined;
        const r = await trialBalanceReport(db, companyId, asOf, from);
        return {
          content: `Trial balance as at ${day(r.asOf)}: debits ${money(r.debitMinor, r.currency)}, credits ${money(r.creditMinor, r.currency)}${r.balances ? ', in agreement' : ` (out by ${money(r.differenceMinor, r.currency)}; tell a person)`}.`,
          data: { currency: r.currency, asOf: day(r.asOf), from: r.from ? day(r.from) : null, balances: r.balances, debit: minorToMajor(r.debitMinor), credit: minorToMajor(r.creditMinor), lines: r.lines.map((l) => ({ code: l.code, name: l.name, type: l.type, debit: minorToMajor(l.debitMinor), credit: minorToMajor(l.creditMinor) })) },
        };
      }
      case 'entries': {
        const filter: EntryFilter = { limit: Math.min(Number(p['limit'] ?? 200) || 200, 1000) };
        if (str(p['account'])) filter.accountCode = str(p['account'])!;
        if (str(p['type'])) filter.accountType = str(p['type']) as AccountType;
        if (str(p['from'])) filter.from = `${str(p['from'])}T00:00:00.000Z`;
        if (str(p['to'])) filter.to = `${str(p['to'])}T23:59:59.999Z`;
        if (str(p['agent'])) { filter.groupBy = 'agent'; filter.groupKey = str(p['agent'])!; }
        if (str(p['sourceKind'])) filter.sourceKind = str(p['sourceKind']) as SourceKind;
        const r = await listEntries(db, companyId, filter);
        return {
          content: `${r.count} entr${r.count === 1 ? 'y' : 'ies'}${r.truncated ? ' (cut short; narrow the filter)' : ''}, net ${money(r.totalMinor, r.currency)}.`,
          data: { net: minorToMajor(r.totalMinor), debit: minorToMajor(r.debitMinor), credit: minorToMajor(r.creditMinor), truncated: r.truncated, entries: r.rows.map((e) => ({ transactionId: e.transactionId, date: day(e.occurredAt), description: e.description, account: e.accountCode, accountName: e.accountName, [e.direction]: minorToMajor(e.amountMinor), signed: minorToMajor(e.signedMinor), running: minorToMajor(e.runningMinor), sourceKind: e.sourceKind, agent: e.subject.agent ?? null })) },
        };
      }
      case 'transaction': {
        const tx = await getTransaction(db, companyId, String(p['transactionId'] ?? ''));
        if (!tx) throw new LedgerError('transaction not found', 'invalid');
        const source = await describeSource(db, companyId, tx);
        return {
          content: `${day(tx.occurredAt)} ${tx.description}: ${tx.entries.length} lines, source ${source.kind}${tx.reversedBy ? ', reversed' : ''}.`,
          data: { transactionId: tx.id, date: day(tx.occurredAt), description: tx.description, sourceKind: tx.sourceKind, source, reversesId: tx.reversesId, reversedBy: tx.reversedBy, createdBy: tx.createdBy, entries: tx.entries.map((e) => ({ account: e.accountCode, name: e.accountName, [e.direction]: minorToMajor(e.amountMinor), agent: e.subject.agent ?? null })) },
        };
      }
      case 'suppliers': {
        const list = await listSuppliers(db, companyId);
        return { content: `${list.length} supplier(s).`, data: { suppliers: list.map((s) => ({ supplierId: s.id, name: s.name, email: s.email, defaultAccount: s.defaultAccountCode })) } };
      }
      case 'bills': {
        const status = str(p['status']) as BillStatus | undefined;
        let list = await listBills(db, companyId, { ...(status ? { status } : {}), limit: 500 });
        if (p['overdueOnly'] === true) list = list.filter((b) => overdueDays(b) > 0);
        list = list.slice(0, Math.min(Number(p['limit'] ?? 50) || 50, 200));
        const open = list.filter((b) => b.status === 'approved' || b.status === 'part_paid');
        return { content: list.length === 0 ? 'No bills match.' : `${list.length} bill(s); ${open.length} unpaid, ${open.filter((b) => overdueDays(b) > 0).length} overdue.`, data: { bills: list.map(billSummary) } };
      }
      case 'bill': {
        const b = await findBill(db, companyId, p['bill']);
        return { content: `${b.number} from ${b.supplierName}: ${b.status}, ${money(b.totalMinor, b.currency)} total, ${money(b.outstandingMinor, b.currency)} outstanding.`, data: { ...billSummary(b), lines: b.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmount: minorToMajor(l.unitAmountMinor), amount: minorToMajor(l.amountMinor), tax: minorToMajor(l.taxMinor), account: l.accountCode })), payments: b.payments.map((x) => ({ date: day(x.occurredAt), amount: minorToMajor(x.amountMinor), reference: x.reference, fromAccount: x.cashAccountCode })), notes: b.notes } };
      }
      case 'create-bill': {
        const supplier = await resolveSupplier(db, companyId, String(p['supplier'] ?? ''), { create: true, email: str(p['supplierEmail']) ?? null });
        if (!supplier) throw new LedgerError('supplier is required', 'invalid');
        const date = str(p['date']) ? `${str(p['date'])}T12:00:00.000Z` : new Date().toISOString();
        const dueDays = Number(p['dueInDays'] ?? 30);
        const due = new Date(Date.parse(date) + (Number.isFinite(dueDays) ? dueDays : 30) * 86_400_000).toISOString();
        const lines = (Array.isArray(p['lines']) ? (p['lines'] as Array<Record<string, unknown>>) : []).map((l, i) => ({
          description: String(l['description'] ?? ''),
          quantity: str(l['quantity']) ?? '1',
          unitAmountMinor: majorToMinor(l['unitAmount'], `line ${i + 1} unit amount`),
          taxMinor: str(l['tax']) ? majorToMinor(l['tax'], `line ${i + 1} tax`) : null,
          accountCode: str(l['account']) ?? null,
        }));
        let bill = await createBill(db, companyId, { supplierId: supplier.id, currency: str(p['currency'])?.toUpperCase() ?? null, rateToBase: str(p['rateToBase']) ?? null, issuedAt: date, dueAt: due, reference: str(p['reference']) ?? null, notes: str(p['notes']) ?? null, lines, createdBy: by, subject: { agent: run.agentId } });
        if (p['approve'] !== false) bill = await approveBill(db, companyId, bill.id, { createdBy: by });
        return { content: `${bill.number} from ${bill.supplierName}: ${bill.status}, ${money(bill.totalMinor, bill.currency)}, due ${day(bill.dueAt)}.`, data: billSummary(bill) };
      }
      case 'pay-bill': {
        const b = await findBill(db, companyId, p['bill']);
        const paid = await payBill(db, companyId, b.id, { amountMinor: str(p['amount']) ? majorToMinor(p['amount']) : null, reference: str(p['reference']) ?? null, cashAccountCode: str(p['fromAccount']) ?? null, createdBy: by, ...(str(p['date']) ? { occurredAt: `${str(p['date'])}T12:00:00.000Z` } : {}) });
        return { content: `${paid.number}: ${paid.status}, ${money(paid.paidMinor, paid.currency)} paid, ${money(paid.outstandingMinor, paid.currency)} outstanding.`, data: billSummary(paid) };
      }
      case 'void-bill': {
        const b = await findBill(db, companyId, p['bill']);
        const v = await voidBill(db, companyId, b.id, { createdBy: by, ...(str(p['reason']) ? { reason: str(p['reason'])! } : {}) });
        return { content: `${v.number} voided.`, data: billSummary(v) };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (err) {
    if (err instanceof LedgerError || err instanceof RangeError || err instanceof TypeError) return { error: err.message };
    throw err;
  }
}
