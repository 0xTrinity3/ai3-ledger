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
  postTransaction,
  ACCOUNT,
  getWallet,
  createDispute,
  updateDispute,
  listDisputes,
  getDispute,
  type Decision,
  type Invoice,
  type InvoiceStatus,
  type LedgerDb,
  type StatementLine,
} from '../core/index.js';
import { isConnected, publishInvoice, sendInvoice, type FetchLike } from './ai3.js';
import { PATH_USD_SYMBOL, TEMPO_NETWORK, TEMPO_NETWORK_LABEL, balanceCents, ensureWallet, explorerAddress, pay, requestFaucet, syncWalletFeed } from './tempo.js';
import { connectStripe, payInvoiceByCard, refreshStripe, syncStripeFeed } from './stripe.js';
import { fetchCredits, syncCredits } from './credits.js';
import { RecourseError, DISPUTE_CLAUSE, buildBundle, describeRuling, fileDispute, getCase, invoiceForBundle, type CaseRecord, type Ruling } from './recourse.js';
import { BOOKS_TOOL_DECLARATIONS, isBooksTool, runBooksTool } from './books-tools.js';

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

/** The machine-readable copy of a hosted invoice on ai3.co (or any host serving the same JSON). */
export interface RemoteInvoice { number: string; currency: string; totalMinor: string; outstandingMinor: string; issuedAt: string | null; dueAt: string | null; status: string; lines: Array<{ description: string; quantity: string; amountMinor: string }>; notes: string | null; paymentMethods: Array<{ kind: string; label: string; details: Record<string, string> }>; company: { name: string; email: string | null }; disputes: string | null; url: string; /** ai3.co says the seller takes card payments through Stripe */ stripe: { payable: boolean; test?: boolean } | null }
export async function fetchInvoiceDocument(fetch: FetchLike, url: string): Promise<RemoteInvoice> {
  if (!/^https:\/\/[^\s/]+\/i\/[A-Za-z0-9_-]{16,80}$/.test(url.trim())) throw new LedgerError('the invoice link must look like https://ai3.co/i/<token>', 'invalid');
  const r = await fetch(`${url.trim()}.json`, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new LedgerError(`the invoice link answered ${r.status}`, 'invalid');
  const d = (await r.json()) as Partial<RemoteInvoice> & { invoice?: Partial<RemoteInvoice> };
  const inv = (d.invoice ?? d) as Partial<RemoteInvoice>;
  if (!inv.number || !inv.currency) throw new LedgerError('the invoice link did not return an invoice', 'invalid');
  const stripeInfo = (d as { stripe?: { payable?: boolean; test?: boolean } }).stripe;
  return { number: inv.number, currency: inv.currency, totalMinor: String(inv.totalMinor ?? '0'), outstandingMinor: String(inv.outstandingMinor ?? '0'), issuedAt: inv.issuedAt ?? null, dueAt: inv.dueAt ?? null, status: inv.status ?? 'issued', lines: inv.lines ?? [], notes: inv.notes ?? null, paymentMethods: inv.paymentMethods ?? [], company: { name: inv.company?.name ?? 'Unknown', email: inv.company?.email ?? null }, disputes: inv.disputes ?? null, url: url.trim(), stripe: stripeInfo ? { payable: stripeInfo.payable === true, test: stripeInfo.test === true } : null };
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
    name: 'credits',
    displayName: 'Model credits',
    description: 'The company’s prepaid model credits at ai3.co: balance left, what was put in, what model usage has been charged (at cost plus the platform markup), and how to top up (pathUSD to the platform wallet with the credit memo, which the pay-invoice tool can send). Pass sync true to book the latest grants and usage into the ledger now.',
    parametersSchema: { type: 'object', properties: { sync: { type: 'boolean' } }, additionalProperties: false },
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
  {
    name: 'wallet',
    displayName: 'Company wallet',
    description: 'The company’s stablecoin wallet on Tempo (Stripe’s payments chain, testnet): address, pathUSD balance, explorer link. It is printed on invoices as a payment option and its feed reconciles itself. Pass topUp true to ask the testnet faucet for more test money.',
    parametersSchema: { type: 'object', properties: { topUp: { type: 'boolean', description: 'Request test stablecoins from the faucet.' }, sync: { type: 'boolean', description: 'Read new chain transfers into the books now instead of waiting for the feed job.' } }, additionalProperties: false },
  },
  {
    name: 'pay-invoice',
    displayName: 'Pay an invoice',
    description: 'Pay an invoice the company received. Two rails: pathUSD from the company wallet on Tempo (invoice number in the transfer memo, so the seller’s books reconcile it), or the card the owner saved on ai3.co through Stripe (the seller must take card payments; the charge lands on their Stripe account with the invoice number). Give the invoice’s online link (an ai3.co/i/… URL) and amount, currency, payee and invoice number are read from it; or give a raw wallet address and amount. rail defaults to auto: the wallet when the invoice offers one and the balance covers it, else the card. Books the payment as an expense.',
    parametersSchema: {
      type: 'object',
      properties: {
        invoiceUrl: { type: 'string', description: 'The invoice’s online link, e.g. https://ai3.co/i/abc. Amount, currency, payee address and invoice number come from it.' },
        rail: { type: 'string', enum: ['auto', 'tempo', 'stripe'], description: 'How to pay: the Tempo wallet, the saved card through Stripe, or auto (default).' },
        to: { type: 'string', description: 'Payee wallet address, when there is no invoice link.' },
        amount: { ...AMOUNT, description: 'Amount to pay. Defaults to the invoice’s outstanding amount.' },
        memo: { type: 'string', description: 'Up to 32 characters in the transfer memo. Defaults to the invoice number.' },
        description: { type: 'string', description: 'What this pays for, for the books.' },
        accountCode: { type: 'string', description: 'Expense account to book it to. Defaults to 5900 Other operating; 5100 for tools and APIs, 5000 for model inference.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'stripe',
    displayName: 'Stripe (cards)',
    description: 'The company’s Stripe through ai3.co: whether card payments are on (invoices then carry a Pay by card button and other companies can pay from their saved card), the card this company has on file for paying others, and links to fix either. Pass connect true to start or continue Stripe onboarding (returns a link the owner opens); sync true to read new Stripe charges, fees and payouts into the books now.',
    parametersSchema: { type: 'object', properties: { connect: { type: 'boolean', description: 'Create the connected account if needed and return the onboarding link.' }, sync: { type: 'boolean', description: 'Read the Stripe balance into the books now instead of waiting for the feed job.' } }, additionalProperties: false },
  },
  {
    name: 'dispute-invoice',
    displayName: 'Dispute an invoice',
    description: 'File a dispute at Recourse (recourse.so), the venue every invoice names, signed with the company wallet. As the buyer, give the invoice’s online link and what went wrong. As the seller, give your own invoice number (for example non-payment) and the buyer’s wallet address. The ruling comes back in about a minute with a fault split and a money instruction on the Tempo rail; use settle-dispute to carry it out.',
    parametersSchema: {
      type: 'object',
      properties: {
        invoiceUrl: { type: 'string', description: 'The other party’s invoice link, when you are the buyer.' },
        invoice: { type: 'string', description: 'Your own invoice number or id, when you are the seller.' },
        counterpartyAddress: { type: 'string', description: 'The other party’s wallet address, needed when you are the seller.' },
        breach: { type: 'string', description: 'What was agreed and what went wrong, in plain words.' },
        remedy: { type: 'string', description: 'What you want: refund, payment, reduction.' },
        evidence: { type: 'string', description: 'Anything else the adjudicator should read: delivery notes, messages, dates.' },
        amount: { ...AMOUNT, description: 'Amount in dispute. Defaults to the invoice’s outstanding amount.' },
      },
      required: ['breach'],
      additionalProperties: false,
    },
  },
  {
    name: 'dispute',
    displayName: 'Dispute status',
    description: 'Disputes this company is party to, with the ruling and money instruction once decided. Pass a dispute or case id for one and it is refreshed from the venue.',
    parametersSchema: { type: 'object', properties: { dispute: { type: 'string', description: 'Dispute id or Recourse case id. Omit to list all.' } }, additionalProperties: false },
  },
  {
    name: 'settle-dispute',
    displayName: 'Settle a dispute',
    description: 'Carry out a ruling’s money instruction from the company wallet: every transfer the ruling says this company owes is sent in pathUSD with the case id in the memo, and booked.',
    parametersSchema: { type: 'object', properties: { dispute: { type: 'string', description: 'Dispute id or Recourse case id.' } }, required: ['dispute'], additionalProperties: false },
  },
  ...BOOKS_TOOL_DECLARATIONS,
];

// ---------------------------------------------------------------------------
// The dispatcher
// ---------------------------------------------------------------------------

export async function connectedPublish(deps: ToolDeps, inv: Invoice): Promise<Invoice> {
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
      case 'credits': {
        const settings = await getSettings(db, companyId, deps.baseCurrency);
        if (!isConnected(settings)) return { content: 'This company is not connected to ai3.co, so no model credits are metered for it.', data: { connected: false } };
        const v = await fetchCredits(deps.fetch, settings, companyId);
        const synced = p['sync'] === true ? await syncCredits(db, deps.fetch, settings, companyId, by) : null;
        if (!v.hosted || !v.keyed) return { content: v.message ?? 'This company runs on its own model key; ai3.co meters nothing for it.', data: { ...v, synced } };
        return {
          content: `Model credits: ${minorToMajor(v.remainingMinor)} USD left of ${minorToMajor(v.grantedMinor)} put in; ${minorToMajor(v.chargedMinor)} charged so far (${minorToMajor(v.usageMinor)} at cost plus ${Math.round(v.markup * 100)}%), ${minorToMajor(v.usageMonthlyMinor)} at cost this month.${v.keyDisabled ? ' The key is paused: the balance is used up.' : ''}${v.platformWallet ? ` Top up by sending pathUSD to ${v.platformWallet} with memo "${v.memo}" (pay-invoice tool: to, amount, memo).` : ''}${synced ? ` Booked now: ${synced.grantsBooked} grant(s), ${minorToMajor(synced.usageBookedMinor)} usage.` : ''}`,
          data: { ...v, remaining: minorToMajor(v.remainingMinor), granted: minorToMajor(v.grantedMinor), charged: minorToMajor(v.chargedMinor), synced },
        };
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
      case 'wallet': {
        const ens = await ensureWallet(db, companyId, deps.baseCurrency);
        const w = ens.wallet;
        let faucet: { ok: boolean; detail: string } | null = ens.faucet ?? null;
        if (p['topUp'] === true && !ens.created) faucet = await requestFaucet(w.address);
        let synced: Awaited<ReturnType<typeof syncWalletFeed>> = null;
        if (p['sync'] === true) synced = await syncWalletFeed(db, companyId, { by });
        const bal = await balanceCents(w.address).catch(() => null);
        return {
          content: `Wallet ${w.address} on ${TEMPO_NETWORK_LABEL}: ${bal === null ? 'balance unavailable' : `${minorToMajor(bal)} ${PATH_USD_SYMBOL}`}.${faucet ? ` Faucet: ${faucet.ok ? 'topped up' : `failed (${faucet.detail.slice(0, 80)})`}.` : ''}${synced ? ` Chain read: ${synced.imported} new transfer(s), ${synced.autoPosted} posted, ${synced.leftForReview} to review.` : ''}`,
          data: { address: w.address, network: w.network, networkLabel: TEMPO_NETWORK_LABEL, asset: PATH_USD_SYMBOL, balance: bal === null ? null : minorToMajor(bal), explorer: explorerAddress(w.address), bankAccountId: w.bankAccountId, paymentMethodId: w.paymentMethodId, faucet, synced },
        };
      }
      case 'stripe': {
        const settings = await getSettings(db, companyId, deps.baseCurrency);
        if (!isConnected(settings)) return { content: 'Stripe runs through ai3.co, and this company is not connected to ai3.co yet. Ask the owner to add the company key under Finance › Settings.', data: { connected: false } };
        const wantConnect = p['connect'] === true;
        const { remote, link } = wantConnect ? await connectStripe(db, deps.fetch, settings, companyId, { companyName: await deps.companyName(companyId) }, deps.baseCurrency) : await refreshStripe(db, deps.fetch, settings, companyId, deps.baseCurrency);
        let synced: Awaited<ReturnType<typeof syncStripeFeed>> = null;
        if (p['sync'] === true) synced = await syncStripeFeed(db, deps.fetch, settings, companyId, { by });
        const state = !remote.connected ? 'not connected: no Stripe account yet' : remote.chargesEnabled ? 'card payments on' : `onboarding incomplete${remote.requirementsDue.length ? ` (${remote.requirementsDue.length} item(s) still needed)` : ''}`;
        return {
          content: `Stripe: ${state}${remote.test ? ' (test mode)' : ''}. Card on file for paying others: ${remote.card ? `${remote.card.brand} ····${remote.card.last4 ?? ''}` : 'none'}${remote.onboardingUrl ? `. Onboarding link for the owner: ${remote.onboardingUrl}` : ''}${!remote.card && remote.cardUrl ? `. Add a card: ${remote.cardUrl}` : ''}${synced ? `. Stripe read: ${synced.imported} new line(s), ${synced.autoPosted} posted, ${synced.leftForReview} to review.` : ''}`,
          data: { ...remote, bankAccountId: link?.bankAccountId ?? null, paymentMethodId: link?.paymentMethodId ?? null, synced },
        };
      }
      case 'pay-invoice': {
        const url = str(p['invoiceUrl']);
        const railParam = str(p['rail']) ?? 'auto';
        if (!['auto', 'tempo', 'stripe'].includes(railParam)) throw new LedgerError('rail must be auto, tempo or stripe', 'invalid');
        const doc = url ? await fetchInvoiceDocument(deps.fetch, url) : null;
        const tempoMethod = doc?.paymentMethods.find((m) => m.kind === 'crypto' && /tempo/i.test(m.details.network ?? '') && m.details.address) ?? null;
        const cardPayable = Boolean(doc && (doc.stripe?.payable || doc.paymentMethods.some((m) => m.kind === 'stripe' && m.details.account)));
        let requested = p['amount'] !== undefined && p['amount'] !== '' ? majorToMinor(p['amount']) : null;
        // Which rail: what the invoice offers, what the company holds.
        let rail: 'tempo' | 'stripe' = railParam === 'stripe' ? 'stripe' : 'tempo';
        if (railParam === 'auto' && doc) {
          const need = requested ?? BigInt(doc.outstandingMinor);
          let walletCovers = false;
          if (tempoMethod && doc.currency === 'USD') {
            const w = await ensureWallet(db, companyId, deps.baseCurrency);
            const bal = await balanceCents(w.wallet.address).catch(() => null);
            walletCovers = bal !== null && bal >= need;
          }
          rail = walletCovers ? 'tempo' : cardPayable ? 'stripe' : 'tempo';
        }
        if (rail === 'stripe') {
          if (!doc || !url) throw new LedgerError('paying by card needs the invoice’s online link', 'invalid');
          if (!cardPayable) throw new LedgerError(`invoice ${doc.number} from ${doc.company.name} cannot be paid by card: the seller has not connected Stripe. Pay from the wallet instead, or ask them.`, 'invalid');
          const settings = await getSettings(db, companyId, deps.baseCurrency);
          const r = await payInvoiceByCard(db, deps.fetch, settings, companyId, { invoiceUrl: url, amountCents: requested, description: str(p['description']) ?? null, accountCode: str(p['accountCode']) ?? null, by });
          return {
            content: `Paid ${minorToMajor(r.amountMinor)} ${r.currency} by card${r.card ? ` (${r.card.brand} ····${r.card.last4 ?? ''})` : ''} for invoice ${r.invoiceNumber} from ${r.seller} through Stripe. Payment ${r.paymentIntentId}. Booked to ${r.accountCode}.`,
            data: { rail: 'stripe', paymentIntentId: r.paymentIntentId, amount: minorToMajor(r.amountMinor), currency: r.currency, invoice: r.invoiceNumber, seller: r.seller, fee: minorToMajor(BigInt(r.feeMinor || '0')), accountCode: r.accountCode, at: r.at },
          };
        }
        const { wallet } = await ensureWallet(db, companyId, deps.baseCurrency);
        let to = str(p['to']);
        let amountCents = requested;
        let memo = str(p['memo']);
        let description = str(p['description']);
        let remote: { number: string; company: string; currency: string } | null = null;
        if (doc) {
          const crypto = tempoMethod;
          if (!crypto?.details.address) throw new LedgerError(`invoice ${doc.number} offers no Tempo wallet to pay into${cardPayable ? '; pass rail "stripe" to pay by card' : ''}`, 'invalid');
          if (doc.currency !== 'USD') throw new LedgerError(`invoice ${doc.number} is in ${doc.currency}; the wallet pays ${PATH_USD_SYMBOL} (USD) only${cardPayable ? '; pass rail "stripe" to pay by card' : ''}`, 'invalid');
          to = crypto.details.address;
          amountCents = amountCents ?? BigInt(doc.outstandingMinor);
          memo = memo ?? doc.number;
          description = description ?? `Invoice ${doc.number} from ${doc.company.name}`;
          remote = { number: doc.number, company: doc.company.name, currency: doc.currency };
        }
        if (!to) throw new LedgerError('give an invoice link or a payee address', 'invalid');
        if (amountCents === null) throw new LedgerError('give an amount', 'invalid');
        if (!memo) memo = description?.slice(0, 32) ?? 'payment';
        const result = await pay(wallet, { to, amountCents, memo });
        // Tell the seller's online copy. ai3.co trusts nothing from this call:
        // it reads the receipt from the chain and marks the invoice paid only
        // for a transfer to the address printed on it. Failing to report is
        // noted, never fatal — the money has moved and the books say so.
        let reported: string | null = null;
        if (url) {
          try {
            const r = await deps.fetch(`${url}/paid`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', accept: 'application/json' },
              body: JSON.stringify({ txHash: result.txHash, network: TEMPO_NETWORK, from: wallet.address }),
              signal: AbortSignal.timeout(30_000),
            });
            reported = r.ok ? 'the seller\u2019s online copy is marked paid' : `the seller\u2019s online copy was not updated (${r.status}); it will catch up from the chain`;
          } catch (err) {
            reported = `the seller\u2019s online copy was not reached (${err instanceof Error ? err.message.slice(0, 80) : String(err)})`;
          }
        }
        // Book it: the expense now, the wallet line arrives with the feed and matches this.
        const bank = wallet.bankAccountId ? await getBankAccount(db, companyId, wallet.bankAccountId) : null;
        const code = str(p['accountCode']) ?? ACCOUNT.OTHER_OPERATING;
        if (bank) {
          await postTransaction(db, { companyId, occurredAt: new Date(), description: description ?? `Paid ${to} · ${memo}`, sourcePlatform: 'tempo', sourceKind: 'payment', sourceRef: `tempo:${result.txHash}`, currency: 'USD', entries: [{ accountCode: code, direction: 'debit', amountMinor: amountCents }, { accountCode: bank.accountCode, direction: 'credit', amountMinor: amountCents }], createdBy: by });
        }
        return {
          content: `Paid ${minorToMajor(amountCents)} ${PATH_USD_SYMBOL} to ${to}${remote ? ` for invoice ${remote.number} from ${remote.company}` : ''}, memo "${memo}". Transaction ${result.txHash} (${result.explorer}). Booked to ${code}.${reported ? ` ${reported.charAt(0).toUpperCase()}${reported.slice(1)}.` : ''}`,
          data: { txHash: result.txHash, explorer: result.explorer, to, amount: minorToMajor(amountCents), asset: PATH_USD_SYMBOL, memo, invoice: remote?.number ?? null, accountCode: code, reported },
        };
      }
      case 'dispute-invoice': {
        const breach = str(p['breach']);
        if (!breach) throw new LedgerError('say what went wrong (breach)', 'invalid');
        const { wallet } = await ensureWallet(db, companyId, deps.baseCurrency);
        const url = str(p['invoiceUrl']);
        const ownRef = str(p['invoice']);
        const companyName = await deps.companyName(companyId);
        // At the venue the buyer is always the claimant and the seller the respondent; `role` is who opened the case.
        let role: 'claimant' | 'respondent';
        let invoiceForCase: Parameters<typeof buildBundle>[0]['invoice'];
        let claimantAddress: string;
        let respondentAddress: string;
        let invoiceId: string | null = null;
        let invoiceNumber: string;
        if (url) {
          const doc = await fetchInvoiceDocument(deps.fetch, url);
          const crypto = doc.paymentMethods.find((m) => m.kind === 'crypto' && m.details.address);
          respondentAddress = str(p['counterpartyAddress']) ?? crypto?.details.address ?? '0x0000000000000000000000000000000000000000';
          claimantAddress = wallet.address; // we are the buyer
          role = 'claimant';
          invoiceNumber = doc.number;
          invoiceForCase = { number: doc.number, currency: doc.currency, totalMinor: doc.totalMinor, outstandingMinor: doc.outstandingMinor, issuedAt: doc.issuedAt, dueAt: doc.dueAt, lines: doc.lines.map((l) => ({ description: l.description, quantity: l.quantity, amountMinor: l.amountMinor })), notes: doc.notes, url, sellerName: doc.company.name, buyerName: companyName };
        } else if (ownRef) {
          const inv = await findInvoice(db, companyId, ownRef);
          const counter = str(p['counterpartyAddress']);
          if (!counter) throw new LedgerError('as the seller, give the buyer’s wallet address (counterpartyAddress)', 'invalid');
          role = 'respondent'; // we are the provider, opening the case
          claimantAddress = counter;
          respondentAddress = wallet.address;
          invoiceId = inv.id;
          invoiceNumber = inv.number;
          invoiceForCase = invoiceForBundle(inv, companyName);
        } else {
          throw new LedgerError('give the other party’s invoice link, or your own invoice number with the buyer’s wallet address', 'invalid');
        }
        const amountMinor = p['amount'] !== undefined && p['amount'] !== '' ? majorToMinor(p['amount']) : null;
        const row = await createDispute(db, { companyId, invoiceId, invoiceNumber, invoiceUrl: url ?? invoiceForCase.url ?? null, role, amountMinor: amountMinor ?? BigInt(invoiceForCase.outstandingMinor), currency: invoiceForCase.currency, claim: breach, filedBy: by, status: 'filing' });
        const bundle = buildBundle({ role, invoice: invoiceForCase, breach, remedy: str(p['remedy']) ?? null, evidence: str(p['evidence']) ?? null, amountMinor, claimantAddress, respondentAddress, externalRef: `ai3:${companyId}:${row.id}` });
        let rec: CaseRecord;
        try {
          rec = await fileDispute(deps.fetch, wallet.privateKey as `0x${string}`, bundle);
        } catch (err) {
          await updateDispute(db, companyId, row.id, { status: 'failed' });
          throw err;
        }
        const ruling = (rec.ruling ?? null) as Ruling | null;
        const saved = await updateDispute(db, companyId, row.id, { caseId: rec.id, status: ruling ? 'decided' : rec.status || 'pending', ruling, instruction: rec.rail_instruction ?? null });
        return {
          content: ruling ? `Dispute ${rec.id} filed at Recourse over ${invoiceNumber}. ${describeRuling(ruling)}${rec.rail_instruction ? ' Use settle-dispute to carry out the money instruction.' : ''}` : `Dispute ${rec.id} filed at Recourse over ${invoiceNumber}; the ruling is still being written. Check with the dispute tool.`,
          data: { disputeId: saved.id, caseId: rec.id, status: saved.status, role, invoice: invoiceNumber, ruling, instruction: rec.rail_instruction ?? null, caseUrl: `https://recourse.so/disputes/${rec.id}` },
        };
      }
      case 'dispute': {
        const ref = str(p['dispute']);
        if (!ref) {
          const all = await listDisputes(db, companyId);
          return { content: all.length === 0 ? 'No disputes.' : `${all.length} dispute(s): ${all.map((d) => `${d.invoiceNumber ?? '?'} (${d.role}, ${d.status})`).join('; ')}.`, data: { disputes: all.map((d) => ({ disputeId: d.id, caseId: d.caseId, invoice: d.invoiceNumber, role: d.role, status: d.status, amount: minorToMajor(d.amountMinor), currency: d.currency, filedAt: d.filedAt, ruling: d.ruling, instruction: d.instruction, settledTx: d.settledTx })) } };
        }
        let d = await getDispute(db, companyId, ref);
        if (!d) throw new LedgerError(`no dispute ${ref}`, 'invalid');
        if (d.caseId && (d.status === 'pending' || d.status === 'filed' || !d.ruling)) {
          const rec = await getCase(deps.fetch, d.caseId);
          const ruling = (rec.ruling ?? null) as Ruling | null;
          d = await updateDispute(db, companyId, d.id, { status: ruling ? 'decided' : rec.status || d.status, ruling, instruction: rec.rail_instruction ?? d.instruction });
        }
        const ruling = d.ruling as Ruling | null;
        return { content: ruling ? `${d.invoiceNumber ?? d.id}: ${describeRuling(ruling)}` : `${d.invoiceNumber ?? d.id}: ${d.status}.`, data: { disputeId: d.id, caseId: d.caseId, invoice: d.invoiceNumber, role: d.role, status: d.status, ruling, instruction: d.instruction, settledTx: d.settledTx, caseUrl: d.caseId ? `https://recourse.so/disputes/${d.caseId}` : null } };
      }
      case 'settle-dispute': {
        const ref = str(p['dispute']);
        const d = ref ? await getDispute(db, companyId, ref) : null;
        if (!d) throw new LedgerError(`no dispute ${ref ?? ''}`, 'invalid');
        const instr = d.instruction as { rail?: string; transfer_intents?: Array<{ to: string; amount_minor: number; asset: string; memo: string }> } | null;
        if (!instr || instr.rail !== 'tempo' || !instr.transfer_intents?.length) throw new LedgerError('this dispute has no Tempo money instruction to carry out', 'invalid');
        if (d.settledTx) return { content: `Already settled: ${d.settledTx}.`, data: { disputeId: d.id, settledTx: d.settledTx } };
        const { wallet } = await ensureWallet(db, companyId, deps.baseCurrency);
        const bank = wallet.bankAccountId ? await getBankAccount(db, companyId, wallet.bankAccountId) : null;
        const mine = wallet.address.toLowerCase();
        const owed = instr.transfer_intents.filter((t) => t.to.toLowerCase() !== mine && t.amount_minor > 0);
        if (owed.length === 0) return { content: 'The ruling sends nothing from this company; the other party settles.', data: { disputeId: d.id, owed: [] } };
        const txs: string[] = [];
        for (const t of owed) {
          const cents = BigInt(t.amount_minor);
          const r = await pay(wallet, { to: t.to, amountCents: cents, memo: t.memo });
          txs.push(r.txHash);
          if (bank) {
            const code = d.role === 'respondent' ? ACCOUNT.SERVICE_INCOME : ACCOUNT.OTHER_OPERATING;
            await postTransaction(db, { companyId, occurredAt: new Date(), description: `Dispute ${d.caseId ?? d.id} settlement to ${t.to}`, sourcePlatform: 'tempo', sourceKind: 'payment', sourceRef: `tempo:${r.txHash}`, currency: 'USD', entries: [{ accountCode: code, direction: 'debit', amountMinor: cents }, { accountCode: bank.accountCode, direction: 'credit', amountMinor: cents }], createdBy: by });
          }
        }
        const after = await updateDispute(db, companyId, d.id, { status: 'settled', settledTx: txs.join(',') });
        return { content: `Settled: ${owed.map((t, i) => `${minorToMajor(BigInt(t.amount_minor))} ${PATH_USD_SYMBOL} to ${t.to} (${txs[i]})`).join('; ')}.`, data: { disputeId: after.id, settledTx: after.settledTx, transfers: owed.map((t, i) => ({ to: t.to, amount: minorToMajor(BigInt(t.amount_minor)), txHash: txs[i] })) } };
      }
      default:
        if (isBooksTool(name)) return runBooksTool(db, name, rawParams, run);
        return { error: `Unknown tool ${name}` };
    }
  } catch (err) {
    if (err instanceof LedgerError || err instanceof RangeError || err instanceof TypeError) return { error: err.message };
    if (err instanceof Error && err.name === 'Ai3Error') return { error: err.message };
    if (err instanceof RecourseError) return { error: err.message };
    throw err;
  }
}
