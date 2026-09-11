/**
 * Agent tools: what an agent in the company can do with the books.
 *
 * Paperclip exposes every tool declared in the manifest through its tool
 * gateway as `ai3.ledger:<name>`. The host injects the calling agent, run and
 * company; the tool never takes a company from the agent. Amounts in and out
 * are in major units ("1250.00"), which is how an agent talks about money;
 * the core keeps minor units.
 *
 * There is no separate permission layer here by decision: an agent can do
 * everything a board member can from the page, including void and write off.
 */
import type { PluginToolDeclaration, ToolResult, ToolRunContext } from '@paperclipai/plugin-sdk';
import {
  LedgerError,
  applyDecision,
  balanceSheet,
  createCustomer,
  createInvoice,
  decisionOf,
  getBankAccount,
  getInvoice,
  getRate,
  getSettings,
  getStatementLine,
  issueInvoice,
  listBankAccounts,
  listCustomers,
  listInvoices,
  listStatementLines,
  markInvoiceSent,
  position,
  profitAndLoss,
  propose,
  recordPayment,
  runReconciliation,
  saveProposal,
  setInvoiceHosted,
  voidInvoice,
  writeOffInvoice,
  type Decision,
  type Invoice,
  type InvoiceStatus,
  type LedgerDb,
  type StatementLine,
} from '../core/index.js';
import { isConnected, publishInvoice, sendInvoice, type FetchLike } from './ai3.js';

export interface ToolDeps {
  db: LedgerDb;
  fetch: FetchLike;
  companyName: (companyId: string) => Promise<string>;
  baseCurrency: string;
}

// ---------------------------------------------------------------------------
// Money in and out of the tool boundary
// ---------------------------------------------------------------------------

const MAJOR = /^-?\d{1,15}(\.\d{1,2})?$/;

const NO_PAYMENT_OPTIONS = 'this invoice carries no payment details because the company has no payment options set. The customer cannot pay from it. Ask the owner to add a bank account, Stripe link or wallet under Finance › Settings › Payment options; issued invoices pick up the defaults when re-published.';

/** "1250.5" → 125050n. Two decimal places, as every currency here is kept. */
export function majorToMinor(v: unknown, what = 'amount'): bigint {
  const s = String(v ?? '').trim().replace(/,/g, '');
  if (!MAJOR.test(s)) throw new LedgerError(`${what} must be a number with up to two decimals, like 1250.00`, 'invalid');
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const minor = BigInt(whole) * 100n + BigInt((frac + '00').slice(0, 2));
  return neg ? -minor : minor;
}

export function minorToMajor(v: string | bigint): string {
  const n = typeof v === 'bigint' ? v : BigInt(v);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
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

function invoiceSummary(inv: Invoice): Record<string, unknown> {
  return {
    invoiceId: inv.id,
    number: inv.number,
    status: inv.status,
    customer: inv.customerName,
    customerEmail: inv.customerEmail,
    currency: inv.currency,
    total: minorToMajor(inv.totalMinor),
    paid: minorToMajor(inv.paidMinor),
    outstanding: minorToMajor(inv.outstandingMinor),
    issuedAt: day(inv.issuedAt),
    dueAt: day(inv.dueAt),
    overdueDays: overdueDays(inv),
    link: inv.hosted?.url ?? null,
    sentTo: inv.hosted?.sentTo ?? null,
    opened: inv.hosted?.openedAt ? inv.hosted.openCount : 0,
  };
}

function overdueDays(inv: Invoice, now = new Date()): number {
  if (!inv.dueAt || !(inv.status === 'issued' || inv.status === 'part_paid')) return 0;
  const d = Math.floor((now.getTime() - Date.parse(inv.dueAt)) / 86_400_000);
  return d > 0 ? d : 0;
}

function lineSummary(line: StatementLine): Record<string, unknown> {
  const p = line.proposal;
  return {
    lineId: line.id,
    date: day(line.postedAt),
    amount: minorToMajor(line.amountMinor),
    description: line.description,
    payee: line.payee,
    reference: line.reference,
    status: line.status,
    proposal: p
      ? {
          kind: p.kind,
          confidence: p.confidence,
          reason: p.reason,
          accountCode: p.accountCode,
          transactionIds: p.transactionIds,
          invoiceId: p.invoiceId,
          otherBankAccountId: p.otherBankAccountId,
          options: p.options?.map((o) => ({ label: o.label, decision: o.decision })),
        }
      : null,
  };
}

/** Find an invoice by id or number, within the company. */
async function findInvoice(db: LedgerDb, companyId: string, ref: unknown): Promise<Invoice> {
  const key = str(ref);
  if (!key) throw new LedgerError('invoice is required: the invoice id or its number, like INV-0007', 'invalid');
  if (/^[0-9a-f-]{36}$/i.test(key)) {
    const byId = await getInvoice(db, companyId, key);
    if (byId) return byId;
  }
  const all = await listInvoices(db, companyId, { limit: 500 });
  const hit = all.find((i) => i.number.toLowerCase() === key.toLowerCase());
  if (!hit) throw new LedgerError(`no invoice ${key} in this company`, 'invalid');
  return (await getInvoice(db, companyId, hit.id)) ?? hit; // the list carries no lines
}

// ---------------------------------------------------------------------------
// Declarations: the manifest lists these, the host validates params against
// them before calling us.
// ---------------------------------------------------------------------------

const AMOUNT = { type: 'string', description: 'Amount in major units with up to two decimals, e.g. "1250.00".' };
const DATE = { type: 'string', description: 'A date, YYYY-MM-DD. Defaults to today.' };

export const TOOL_DECLARATIONS: PluginToolDeclaration[] = [
  {
    name: 'position',
    displayName: 'Financial position',
    description: 'What the company holds and burns right now: treasury (cash across bank accounts), receivables owed by customers, month-to-date income and expense, trailing 30-day burn, and runway in days. Use this before deciding anything that spends or collects money.',
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'invoices',
    displayName: 'List invoices',
    description: 'Invoices the company has raised, newest first, with status, totals, outstanding amount, days overdue, and whether the customer opened the online copy. Filter by status or ask for overdue only.',
    parametersSchema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['draft', 'issued', 'part_paid', 'paid', 'written_off', 'void'], description: 'Only invoices in this status.' },
        overdueOnly: { type: 'boolean', description: 'Only open invoices past their due date.' },
        limit: { type: 'integer', minimum: 1, maximum: 200 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'invoice',
    displayName: 'Invoice detail',
    description: 'One invoice in full: lines, payments received, payment options printed on it, the online link, and sent/opened status.',
    parametersSchema: { type: 'object', properties: { invoice: { type: 'string', description: 'Invoice id or number, e.g. INV-0007.' } }, required: ['invoice'], additionalProperties: false },
  },
  {
    name: 'customers',
    displayName: 'List customers',
    description: 'The customers the company has invoiced or set up, with ids and emails.',
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'create-invoice',
    displayName: 'Create and issue an invoice',
    description: 'Raise an invoice for a customer. Names a customer (created if new), lists what is being billed, and by default issues it immediately, which posts the receivable and creates the online copy. Pass sendTo to email it in the same step. Amounts are in the invoice currency; a non-base currency is converted at the published rate unless rateToBase is given.',
    parametersSchema: {
      type: 'object',
      properties: {
        customer: { type: 'string', description: 'Customer name (matched case-insensitively, created if new) or customer id.' },
        customerEmail: { type: 'string', description: 'Email for a new customer, or to update a customer that has none.' },
        currency: { type: 'string', description: 'ISO code or stablecoin symbol, e.g. USD, EUR, GBP, USDC. Defaults to the company base currency.' },
        rateToBase: { type: 'string', description: 'Units of base currency per one unit of the invoice currency. Only for a non-base currency; looked up when omitted.' },
        lines: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            properties: { description: { type: 'string' }, quantity: { type: 'string', description: 'Defaults to 1.' }, unitAmount: AMOUNT },
            required: ['description', 'unitAmount'],
            additionalProperties: false,
          },
        },
        dueInDays: { type: 'integer', minimum: 0, maximum: 365, description: 'Payment terms. Defaults to 30.' },
        notes: { type: 'string', description: 'Printed under the lines.' },
        issue: { type: 'boolean', description: 'Issue now (default true). false keeps a draft.' },
        sendTo: { type: 'string', description: 'Email the issued invoice to this address right away.' },
        message: { type: 'string', description: 'A short note in the email when sendTo is given.' },
      },
      required: ['customer', 'lines'],
      additionalProperties: false,
    },
  },
  {
    name: 'send-invoice',
    displayName: 'Send an invoice',
    description: 'Email an issued invoice to the customer from the company owner’s Gmail, with a link to the online copy. Opens are tracked. Requires the company to be connected to ai3.co.',
    parametersSchema: {
      type: 'object',
      properties: {
        invoice: { type: 'string', description: 'Invoice id or number.' },
        to: { type: 'string', description: 'Recipient. Defaults to the customer’s email.' },
        cc: { type: 'string' },
        message: { type: 'string', description: 'A short note above the invoice summary.' },
      },
      required: ['invoice'],
      additionalProperties: false,
    },
  },
  {
    name: 'record-payment',
    displayName: 'Record a payment',
    description: 'Record money received against an invoice. Defaults to the full outstanding amount. Books the cash, clears the receivable, and any exchange difference goes to currency gains and losses.',
    parametersSchema: {
      type: 'object',
      properties: {
        invoice: { type: 'string', description: 'Invoice id or number.' },
        amount: { ...AMOUNT, description: 'Amount received in the invoice currency. Defaults to what is outstanding.' },
        date: DATE,
        reference: { type: 'string', description: 'Bank or transaction reference.' },
        rateToBase: { type: 'string', description: 'Rate applied by the bank that day, for a non-base currency. Defaults to the published rate.' },
      },
      required: ['invoice'],
      additionalProperties: false,
    },
  },
  {
    name: 'void-invoice',
    displayName: 'Void an invoice',
    description: 'Cancel an invoice that was raised in error. A draft is simply voided; an issued one is reversed so the receivable disappears. Cannot be undone.',
    parametersSchema: { type: 'object', properties: { invoice: { type: 'string' }, reason: { type: 'string' } }, required: ['invoice'], additionalProperties: false },
  },
  {
    name: 'write-off-invoice',
    displayName: 'Write off an invoice',
    description: 'Give up on collecting what is outstanding on an invoice: the receivable moves to bad debt expense.',
    parametersSchema: { type: 'object', properties: { invoice: { type: 'string' }, reason: { type: 'string' } }, required: ['invoice'], additionalProperties: false },
  },
  {
    name: 'bank-accounts',
    displayName: 'Bank accounts',
    description: 'The company’s bank accounts and wallets with the balance in the books, the last statement balance, and how many statement lines still need reconciling.',
    parametersSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'reconcile-queue',
    displayName: 'Reconciliation queue',
    description: 'Statement lines not yet explained in the books, each with the ledger’s proposal (match an existing transaction, create a new one against an account, a transfer between accounts, or a question with options) and its confidence and reason. Work through these with the reconcile tool.',
    parametersSchema: {
      type: 'object',
      properties: { bankAccountId: { type: 'string', description: 'One account. Defaults to every account.' }, limit: { type: 'integer', minimum: 1, maximum: 200 } },
      additionalProperties: false,
    },
  },
  {
    name: 'reconcile',
    displayName: 'Reconcile a statement line',
    description: 'Settle one statement line. Either accept the proposal as shown in the queue, or give a decision: match (transactionIds), create (accountCode, description, contactName), transfer (otherBankAccountId), or exclude (reason). A confirmed decision teaches a rule for the same payee next time.',
    parametersSchema: {
      type: 'object',
      properties: {
        lineId: { type: 'string' },
        accept: { type: 'boolean', description: 'Apply the proposal from the queue.' },
        decision: {
          type: 'object',
          properties: {
            kind: { type: 'string', enum: ['match', 'create', 'transfer', 'exclude'] },
            transactionIds: { type: 'array', items: { type: 'string' } },
            accountCode: { type: 'string', description: 'Account code to post against, e.g. 5100 for a cost of service.' },
            description: { type: 'string' },
            contactName: { type: 'string' },
            otherBankAccountId: { type: 'string' },
            otherLineId: { type: 'string' },
            invoiceId: { type: 'string', description: 'For money in that pays an invoice: create against receivables with this invoice.' },
            reason: { type: 'string' },
          },
          required: ['kind'],
          additionalProperties: false,
        },
      },
      required: ['lineId'],
      additionalProperties: false,
    },
  },
  {
    name: 'reconcile-all',
    displayName: 'Reconcile everything confident',
    description: 'Run the matcher over every unreconciled line and post every proposal at or above the confidence threshold (default 90). Returns what was posted and what still needs a decision.',
    parametersSchema: {
      type: 'object',
      properties: { bankAccountId: { type: 'string', description: 'One account. Defaults to every account.' }, threshold: { type: 'integer', minimum: 50, maximum: 100 } },
      additionalProperties: false,
    },
  },
  {
    name: 'profit-and-loss',
    displayName: 'Profit and loss',
    description: 'Income and expense by account for a period. Defaults to the current month to date. Optionally grouped by agent or project.',
    parametersSchema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        to: { type: 'string', description: 'YYYY-MM-DD, inclusive.' },
        groupBy: { type: 'string', enum: ['agent', 'project'] },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'balance-sheet',
    displayName: 'Balance sheet',
    description: 'Assets, liabilities and equity as of a date (default today).',
    parametersSchema: { type: 'object', properties: { asOf: DATE }, additionalProperties: false },
  },
];

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

async function connectedPublish(deps: ToolDeps, inv: Invoice): Promise<Invoice> {
  const settings = await getSettings(deps.db, inv.companyId, deps.baseCurrency);
  if (!isConnected(settings) || inv.hosted || inv.status === 'draft' || inv.status === 'void') return inv;
  const r = await publishInvoice(deps.fetch, settings, inv, await deps.companyName(inv.companyId));
  await setInvoiceHosted(deps.db, inv.companyId, inv.id, r);
  return (await getInvoice(deps.db, inv.companyId, inv.id)) ?? inv;
}

async function send(deps: ToolDeps, inv: Invoice, to: string, cc?: string, message?: string): Promise<{ inv: Invoice; from: string; via: string }> {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new LedgerError('a valid recipient email is required', 'invalid');
  if (!(inv.status === 'issued' || inv.status === 'part_paid')) throw new LedgerError(`invoice ${inv.number} is ${inv.status}; only an issued invoice can be sent`, 'invalid');
  const settings = await getSettings(deps.db, inv.companyId, deps.baseCurrency);
  if (!isConnected(settings)) throw new LedgerError('this company is not connected to ai3.co, so invoices cannot be emailed; a person can connect it under Finance › Settings', 'invalid');
  const withPage = await connectedPublish(deps, inv);
  if (!withPage.hosted) throw new LedgerError('the online copy could not be created', 'invalid');
  const r = await sendInvoice(deps.fetch, settings, { companyId: inv.companyId, token: withPage.hosted.token, to, cc: cc ?? null, message: message ?? null, replyTo: settings.replyTo ?? settings.email ?? null });
  await markInvoiceSent(deps.db, inv.companyId, inv.id, to);
  return { inv: (await getInvoice(deps.db, inv.companyId, inv.id)) ?? withPage, from: r.from, via: r.via };
}

async function queueFor(deps: ToolDeps, companyId: string, bankAccountId: string | undefined, limit: number): Promise<Array<{ bank: string; line: StatementLine }>> {
  const banks = (await listBankAccounts(deps.db, companyId)).filter((b) => !bankAccountId || b.id === bankAccountId);
  if (bankAccountId && banks.length === 0) throw new LedgerError('bank account not found', 'invalid');
  const out: Array<{ bank: string; line: StatementLine }> = [];
  for (const bank of banks) {
    const lines = await listStatementLines(deps.db, companyId, bank.id, { status: 'unreconciled', limit });
    for (const line of lines) {
      if (!line.proposal) {
        const p = await propose(deps.db, companyId, line);
        await saveProposal(deps.db, companyId, line.id, p);
        line.proposal = p;
      }
      out.push({ bank: bank.name, line });
      if (out.length >= limit) return out;
    }
  }
  return out;
}

export async function runTool(deps: ToolDeps, name: string, rawParams: unknown, run: ToolRunContext): Promise<ToolResult> {
  const p = obj(rawParams);
  const companyId = run.companyId;
  const by = `agent:${run.agentId}`;
  const db = deps.db;
  try {
    switch (name) {
      case 'position': {
        const pos = await position(db, companyId);
        const cur = pos.currency;
        const content = [
          `Treasury ${money(pos.treasuryMinor, cur)}; receivables ${money(pos.receivablesMinor, cur)}.`,
          `Month to date: income ${money(pos.monthToDate.incomeMinor, cur)}, expense ${money(pos.monthToDate.expenseMinor, cur)}, net ${money(pos.monthToDate.netMinor, cur)}.`,
          `Trailing 30 days: burn ${money(pos.trailing30d.dailyBurnMinor, cur)} per day; runway ${pos.runwayDays === null ? 'not limited by burn' : `${pos.runwayDays} days`}.`,
        ].join(' ');
        return {
          content,
          data: {
            currency: cur,
            asOf: pos.asOf,
            treasury: minorToMajor(pos.treasuryMinor),
            receivables: minorToMajor(pos.receivablesMinor),
            payables: minorToMajor(pos.payablesMinor),
            monthToDate: { income: minorToMajor(pos.monthToDate.incomeMinor), expense: minorToMajor(pos.monthToDate.expenseMinor), net: minorToMajor(pos.monthToDate.netMinor) },
            dailyBurn: minorToMajor(pos.trailing30d.dailyBurnMinor),
            runwayDays: pos.runwayDays,
            accounts: pos.accounts.map((a) => ({ code: a.code, name: a.name, type: a.type, balance: minorToMajor(a.balanceMinor) })),
          },
        };
      }
      case 'invoices': {
        const status = str(p['status']) as InvoiceStatus | undefined;
        const limit = Math.min(Number(p['limit'] ?? 50) || 50, 200);
        let list = await listInvoices(db, companyId, { ...(status ? { status } : {}), limit: 500 });
        if (p['overdueOnly'] === true) list = list.filter((i) => overdueDays(i) > 0);
        list = list.slice(0, limit);
        const rows = list.map(invoiceSummary);
        const open = list.filter((i) => i.status === 'issued' || i.status === 'part_paid');
        return {
          content: list.length === 0 ? 'No invoices match.' : `${list.length} invoice(s); ${open.length} open, ${open.filter((i) => overdueDays(i) > 0).length} overdue.`,
          data: { invoices: rows },
        };
      }
      case 'invoice': {
        const inv = await findInvoice(db, companyId, p['invoice']);
        return {
          content: `${inv.number} for ${inv.customerName}: ${inv.status}, ${money(inv.totalMinor, inv.currency)} total, ${money(inv.outstandingMinor, inv.currency)} outstanding${inv.hosted?.url ? `, online at ${inv.hosted.url}` : ''}.`,
          data: {
            ...invoiceSummary(inv),
            lines: inv.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmount: minorToMajor(l.unitAmountMinor), amount: minorToMajor(l.amountMinor) })),
            payments: inv.payments.map((x) => ({ date: day(x.occurredAt), amount: minorToMajor(x.amountMinor), reference: x.reference })),
            paymentOptions: inv.paymentMethods.map((m) => ({ kind: m.kind, label: m.label, currency: m.currency, details: m.details })),
            notes: inv.notes,
            baseCurrency: inv.baseCurrency,
            rateToBase: inv.rateToBase,
          },
        };
      }
      case 'customers': {
        const list = await listCustomers(db, companyId);
        return { content: `${list.length} customer(s).`, data: { customers: list.map((c) => ({ customerId: c.id, name: c.name, email: c.email })) } };
      }
      case 'create-invoice': {
        const ref = str(p['customer']);
        if (!ref) throw new LedgerError('customer is required', 'invalid');
        const customers = await listCustomers(db, companyId);
        let customer = customers.find((c) => c.id === ref) ?? customers.find((c) => c.name.toLowerCase() === ref.toLowerCase());
        if (!customer) customer = await createCustomer(db, companyId, { name: ref, email: str(p['customerEmail']) ?? null });
        const settings = await getSettings(db, companyId, deps.baseCurrency);
        const currency = (str(p['currency']) ?? settings.baseCurrency).toUpperCase();
        let rateToBase = str(p['rateToBase']) ?? null;
        if (currency !== settings.baseCurrency && !rateToBase) {
          const q = await getRate(deps.fetch, currency, settings.baseCurrency);
          rateToBase = q.rate;
        }
        const rawLines = Array.isArray(p['lines']) ? (p['lines'] as unknown[]) : [];
        if (rawLines.length === 0) throw new LedgerError('at least one line is required', 'invalid');
        const lines = rawLines.map((l, i) => {
          const o = obj(l);
          const description = str(o['description']);
          if (!description) throw new LedgerError(`line ${i + 1} needs a description`, 'invalid');
          return { description, quantity: str(o['quantity']) ?? '1', unitAmountMinor: majorToMinor(o['unitAmount'], `line ${i + 1} unitAmount`) };
        });
        const dueInDays = Number.isFinite(Number(p['dueInDays'])) ? Number(p['dueInDays']) : 30;
        const dueAt = new Date(Date.now() + dueInDays * 86_400_000);
        let inv = await createInvoice(db, companyId, { customerId: customer.id, currency, rateToBase, lines, dueAt, notes: str(p['notes']) ?? null, createdBy: by });
        let sent: { from: string; via: string } | null = null;
        if (p['issue'] !== false) {
          inv = await issueInvoice(db, companyId, inv.id, { createdBy: by });
          inv = await connectedPublish(deps, inv);
          const to = str(p['sendTo']);
          if (to) {
            const r = await send(deps, inv, to, undefined, str(p['message']));
            inv = r.inv;
            sent = { from: r.from, via: r.via };
          }
        }
        const summary = invoiceSummary(inv);
        const warning = inv.paymentMethods.length === 0 ? NO_PAYMENT_OPTIONS : null;
        return {
          content: `${inv.number} ${inv.status === 'draft' ? 'saved as a draft' : 'issued'} to ${inv.customerName} for ${money(inv.totalMinor, inv.currency)}, due ${day(inv.dueAt)}${inv.hosted?.url ? `. Online copy: ${inv.hosted.url}` : ''}${sent ? `. Emailed to ${inv.hosted?.sentTo} from ${sent.from}` : ''}.${warning ? ` WARNING: ${warning}` : ''}`,
          data: { ...summary, sent, warning },
        };
      }
      case 'send-invoice': {
        const inv = await findInvoice(db, companyId, p['invoice']);
        const to = str(p['to']) ?? inv.customerEmail ?? '';
        if (!to) throw new LedgerError(`${inv.number} has no customer email; pass "to"`, 'invalid');
        const r = await send(deps, inv, to, str(p['cc']), str(p['message']));
        const warning = r.inv.paymentMethods.length === 0 ? NO_PAYMENT_OPTIONS : null;
        return { content: `${inv.number} emailed to ${to} from ${r.from} via ${r.via}. Online copy: ${r.inv.hosted?.url ?? ''}.${warning ? ` WARNING: ${warning}` : ''}`, data: { ...invoiceSummary(r.inv), warning } };
      }
      case 'record-payment': {
        const inv = await findInvoice(db, companyId, p['invoice']);
        const amountMinor = p['amount'] === undefined || p['amount'] === null || p['amount'] === '' ? BigInt(inv.outstandingMinor) : majorToMinor(p['amount']);
        const date = str(p['date']);
        const occurredAt = date ? `${date}T12:00:00.000Z` : new Date();
        let rateToBase = str(p['rateToBase']) ?? null;
        if (inv.currency !== inv.baseCurrency && !rateToBase) {
          try {
            rateToBase = (await getRate(deps.fetch, inv.currency, inv.baseCurrency, date)).rate;
          } catch {
            rateToBase = null; // the issue rate applies
          }
        }
        const after = await recordPayment(db, companyId, inv.id, { amountMinor, occurredAt, reference: str(p['reference']) ?? null, createdBy: by, rateToBase });
        return { content: `Recorded ${money(amountMinor, inv.currency)} against ${inv.number}; now ${after.status}, ${money(after.outstandingMinor, inv.currency)} outstanding.`, data: invoiceSummary(after) };
      }
      case 'void-invoice': {
        const inv = await findInvoice(db, companyId, p['invoice']);
        const after = await voidInvoice(db, companyId, inv.id);
        return { content: `${inv.number} voided.`, data: invoiceSummary(after) };
      }
      case 'write-off-invoice': {
        const inv = await findInvoice(db, companyId, p['invoice']);
        const after = await writeOffInvoice(db, companyId, inv.id, { createdBy: by, ...(str(p['reason']) ? { reason: str(p['reason'])! } : {}) });
        return { content: `${inv.number} written off: ${money(inv.outstandingMinor, inv.currency)} to bad debt.`, data: invoiceSummary(after) };
      }
      case 'bank-accounts': {
        const banks = await listBankAccounts(db, companyId);
        return {
          content: banks.length === 0 ? 'No bank accounts yet.' : banks.map((b) => `${b.name} (${b.currency}): ${money(b.ledgerBalanceMinor, b.currency)} in the books, ${b.unreconciled} line(s) to reconcile`).join('; ') + '.',
          data: { bankAccounts: banks.map((b) => ({ bankAccountId: b.id, name: b.name, kind: b.kind, currency: b.currency, ledgerBalance: minorToMajor(b.ledgerBalanceMinor), statementBalance: b.statementBalanceMinor ? minorToMajor(b.statementBalanceMinor) : null, unreconciled: b.unreconciled })) },
        };
      }
      case 'reconcile-queue': {
        const limit = Math.min(Number(p['limit'] ?? 50) || 50, 200);
        const q = await queueFor(deps, companyId, str(p['bankAccountId']), limit);
        return {
          content: q.length === 0 ? 'Nothing to reconcile.' : `${q.length} line(s) waiting. ${q.filter((x) => (x.line.proposal?.confidence ?? 0) >= 90).length} have a confident proposal; accept those with reconcile {lineId, accept: true}.`,
          data: { queue: q.map((x) => ({ bank: x.bank, ...lineSummary(x.line) })) },
        };
      }
      case 'reconcile': {
        const lineId = str(p['lineId']);
        if (!lineId) throw new LedgerError('lineId is required', 'invalid');
        let decision: (Decision & { invoiceId?: string; reason?: string }) | null = null;
        if (p['accept'] === true) {
          const line = await getStatementLine(db, companyId, lineId);
          if (!line) throw new LedgerError('statement line not found', 'invalid');
          decision = decisionOf(line.proposal ?? (await propose(db, companyId, line)));
        } else if (p['decision'] && typeof p['decision'] === 'object') {
          decision = p['decision'] as Decision & { invoiceId?: string; reason?: string };
        }
        if (!decision) throw new LedgerError('pass accept: true or a decision', 'invalid');
        const r = await applyDecision(db, companyId, lineId, decision, by);
        return { content: `Line reconciled as ${decision.kind}${r.transactionId ? ` (transaction ${r.transactionId})` : ''}.`, data: r };
      }
      case 'reconcile-all': {
        const threshold = Number(p['threshold'] ?? 90) || 90;
        const banks = (await listBankAccounts(db, companyId)).filter((b) => !str(p['bankAccountId']) || b.id === str(p['bankAccountId']));
        let posted = 0;
        let waiting = 0;
        for (const bank of banks) {
          const r = await runReconciliation(db, companyId, bank.id, { threshold, by, autoPost: true });
          posted += r.autoPosted;
          waiting += r.leftForReview;
        }
        return { content: `Posted ${posted} line(s) at or above ${threshold}%; ${waiting} still need a decision.`, data: { posted, waiting, threshold } };
      }
      case 'profit-and-loss': {
        const now = new Date();
        const from = str(p['from']) ? `${str(p['from'])}T00:00:00.000Z` : new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
        const to = str(p['to']) ? `${str(p['to'])}T23:59:59.999Z` : now.toISOString();
        const groupBy = str(p['groupBy']) as 'agent' | 'project' | undefined;
        const r = await profitAndLoss(db, companyId, { from, to }, groupBy ?? null);
        return {
          content: `From ${day(r.from)} to ${day(r.to)}: income ${money(r.incomeMinor, r.currency)}, expense ${money(r.expenseMinor, r.currency)}, net ${money(r.netMinor, r.currency)}.`,
          data: {
            currency: r.currency,
            from: day(r.from),
            to: day(r.to),
            income: minorToMajor(r.incomeMinor),
            expense: minorToMajor(r.expenseMinor),
            net: minorToMajor(r.netMinor),
            lines: r.lines.map((l) => ({ code: l.code, name: l.name, type: l.type, amount: minorToMajor(l.amountMinor) })),
            groups: r.groups.map((g) => ({ key: g.key, income: minorToMajor(g.incomeMinor), expense: minorToMajor(g.expenseMinor), net: minorToMajor(g.netMinor) })),
          },
        };
      }
      case 'balance-sheet': {
        const asOf = str(p['asOf']) ? `${str(p['asOf'])}T23:59:59.999Z` : new Date();
        const r = await balanceSheet(db, companyId, asOf);
        const section = (s: { lines: Array<{ code: string; name: string; balanceMinor: string }>; totalMinor: string }) => ({ total: minorToMajor(s.totalMinor), lines: s.lines.map((l) => ({ code: l.code, name: l.name, balance: minorToMajor(l.balanceMinor) })) });
        return {
          content: `As of ${day(r.asOf)}: assets ${money(r.assets.totalMinor, r.currency)}, liabilities ${money(r.liabilities.totalMinor, r.currency)}, equity ${money(r.equity.totalMinor, r.currency)}${r.balances ? '' : ' (does not balance; tell a person)'}.`,
          data: { currency: r.currency, asOf: day(r.asOf), assets: section(r.assets), liabilities: section(r.liabilities), equity: { ...section(r.equity), retainedEarnings: minorToMajor(r.equity.retainedEarningsMinor) }, balances: r.balances },
        };
      }
      default:
        return { error: `Unknown tool ${name}` };
    }
  } catch (err) {
    if (err instanceof LedgerError || err instanceof RangeError || err instanceof TypeError) return { error: err.message };
    if (err instanceof Error && err.name === 'Ai3Error') return { error: err.message };
    throw err;
  }
}
