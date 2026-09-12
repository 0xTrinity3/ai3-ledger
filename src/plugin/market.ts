/**
 * The marketplace side of the ledger: invoicing for the agents this company
 * sells, and telling ai3.co what has been collected.
 *
 * ai3.co holds the listings, the prices and the entitlements, and it never
 * reaches in here. This asks what is due, raises the invoice in the company's
 * own books, and reports the number back — the same direction as the credits
 * job, so no tenant ever hands the platform its credentials.
 *
 * Three passes, each safe to repeat:
 *   1. invoice    what ai3.co says is due but has no invoice yet
 *   2. collect    compare our own books against what ai3.co has been told
 *   3. commission when this company is the platform, bill developers their 20%
 *
 * The run ref travels on the invoice's `reference`, so the pairing is visible
 * on the document itself rather than held in a side table.
 */
import {
  createCustomer, createInvoice, getSettings, issueInvoice, listCustomers, listInvoices,
  type CompanySettings, type Invoice, type LedgerDb,
} from '../core/index.js';
import { Ai3Error, ai3Call, isConnected, type FetchLike } from './ai3.js';
import { connectedPublish, minorToMajor, type ToolDeps } from './tools.js';
import { DISPUTE_CLAUSE } from './recourse.js';

export interface DueLine { description: string; quantity: string; amountMinor: string }

export interface DueItem {
  ref: string;
  period: string;
  periodFrom: string;
  periodTo: string;
  listing: { slug: string; name: string; version: number };
  buyer: { companyId: string; name: string; email: string | null };
  currency: string;
  lines: DueLine[];
  totalMinor: string;
  capped: boolean;
  notes: string[];
  measuredOn: string | null;
}

export interface OpenItem {
  ref: string;
  number: string;
  url: string | null;
  currency: string;
  totalMinor: string;
  collectedMinor: string;
  buyer: { companyId: string; name: string };
  period: string;
}

export interface CommissionBill {
  sellerCompanyId: string;
  sellerName: string;
  currency: string;
  refs: string[];
  lines: DueLine[];
  totalMinor: string;
  pct: number;
  dueDays: number;
}

export interface MarketRunResult {
  connected: boolean;
  invoiced: Array<{ ref: string; number: string; buyer: string; total: string; url: string | null }>;
  collected: Array<{ ref: string; number: string; amount: string }>;
  commission: Array<{ number: string; developer: string; total: string; runs: number }>;
  skipped: string | null;
  failures: string[];
}

const DEFAULT_DUE_DAYS = 30;

/** The customer record for a buyer, by name, created once. */
async function customerFor(db: LedgerDb, companyId: string, name: string, email: string | null): Promise<string> {
  const customers = await listCustomers(db, companyId);
  const found = customers.find((c) => c.name.toLowerCase() === name.toLowerCase());
  if (found) return found.id;
  return (await createCustomer(db, companyId, { name, email })).id;
}

/** Our own invoice carrying this run ref, if we have already raised it. */
async function invoiceForRef(db: LedgerDb, companyId: string, ref: string): Promise<Invoice | null> {
  const all = await listInvoices(db, companyId, { limit: 500 });
  return all.find((i) => i.reference === ref) ?? null;
}

/**
 * What the buyer should see on the document: the period, what was measured, and
 * anything the platform reduced. A capped bill that did not say so would look
 * like a mistake.
 */
function notesFor(item: DueItem): string {
  const out = [
    `${item.listing.name} for ${item.buyer.name}, ${item.period} (${item.periodFrom.slice(0, 10)} to ${item.periodTo.slice(0, 10)}).`,
  ];
  if (item.measuredOn) out.push(`Figures as published on ${item.measuredOn.slice(0, 10)}.`);
  for (const n of item.notes) out.push(n);
  out.push(DISPUTE_CLAUSE);
  return out.join('\n');
}

export async function billingDue(fetch: FetchLike, settings: CompanySettings, companyId: string): Promise<DueItem[]> {
  const r = (await ai3Call(fetch, settings, '/api/market/billing/due', { companyId })) as { due?: DueItem[] };
  return Array.isArray(r.due) ? r.due : [];
}

export async function billingOpen(fetch: FetchLike, settings: CompanySettings, companyId: string): Promise<OpenItem[]> {
  const r = (await ai3Call(fetch, settings, '/api/market/billing/open', { companyId })) as { open?: OpenItem[] };
  return Array.isArray(r.open) ? r.open : [];
}

/**
 * Raise one invoice for one due month. Idempotent on the run ref: if the
 * invoice already exists in our books it is reported to ai3.co again rather
 * than duplicated, which is what makes a failed report safe to retry.
 */
export async function raiseOne(deps: ToolDeps, companyId: string, settings: CompanySettings, item: DueItem): Promise<{ inv: Invoice; created: boolean }> {
  const existing = await invoiceForRef(deps.db, companyId, item.ref);
  if (existing) return { inv: existing, created: false };
  const customerId = await customerFor(deps.db, companyId, item.buyer.name, item.buyer.email);
  let inv = await createInvoice(deps.db, companyId, {
    customerId,
    currency: item.currency,
    reference: item.ref,
    lines: item.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmountMinor: l.amountMinor })),
    dueAt: new Date(Date.now() + DEFAULT_DUE_DAYS * 86_400_000),
    notes: notesFor(item),
    createdBy: 'market',
  });
  inv = await issueInvoice(deps.db, companyId, inv.id, { createdBy: 'market' });
  inv = await connectedPublish(deps, inv);
  return { inv, created: true };
}

/**
 * The whole marketplace pass for one company.
 *
 * Every failure is collected rather than thrown, so one buyer's bad data cannot
 * stop the other invoices from being raised.
 */
export async function runMarket(deps: ToolDeps, companyId: string): Promise<MarketRunResult> {
  const out: MarketRunResult = { connected: false, invoiced: [], collected: [], commission: [], skipped: null, failures: [] };
  const settings = await getSettings(deps.db, companyId, deps.baseCurrency);
  if (!isConnected(settings)) { out.skipped = 'not connected to ai3.co'; return out; }
  out.connected = true;

  // 1. Invoice what is due.
  let due: DueItem[] = [];
  try { due = await billingDue(deps.fetch, settings, companyId); } catch (err) { out.failures.push(`asking what is due: ${message(err)}`); }
  for (const item of due) {
    try {
      const { inv } = await raiseOne(deps, companyId, settings, item);
      await ai3Call(deps.fetch, settings, '/api/market/billing/issued', { companyId, ref: item.ref, number: inv.number, url: inv.hosted?.url ?? null });
      out.invoiced.push({ ref: item.ref, number: inv.number, buyer: item.buyer.name, total: minorToMajor(inv.totalMinor), url: inv.hosted?.url ?? null });
    } catch (err) {
      out.failures.push(`${item.ref}: ${message(err)}`);
    }
  }

  // 2. Report what has been collected since ai3.co last heard.
  let open: OpenItem[] = [];
  try { open = await billingOpen(deps.fetch, settings, companyId); } catch (err) { out.failures.push(`asking what is open: ${message(err)}`); }
  for (const item of open) {
    try {
      const inv = await invoiceForRef(deps.db, companyId, item.ref);
      if (!inv) continue;
      const delta = BigInt(inv.paidMinor) - BigInt(item.collectedMinor);
      if (delta <= 0n) continue;
      await ai3Call(deps.fetch, settings, '/api/market/billing/paid', { companyId, ref: item.ref, amountMinor: delta.toString() });
      out.collected.push({ ref: item.ref, number: inv.number, amount: minorToMajor(delta) });
    } catch (err) {
      out.failures.push(`${item.ref} collection: ${message(err)}`);
    }
  }

  // 3. Commission, when this company is the platform. ai3.co answers 403 for
  // everyone else, which is not a failure worth reporting.
  let bills: CommissionBill[] = [];
  try {
    const r = (await ai3Call(deps.fetch, settings, '/api/market/commission/due', { companyId })) as { due?: CommissionBill[] };
    bills = Array.isArray(r.due) ? r.due : [];
  } catch (err) {
    const m = message(err);
    if (!/only the platform company|no platform company/i.test(m)) out.failures.push(`asking what commission is due: ${m}`);
  }
  for (const bill of bills) {
    try {
      const customerId = await customerFor(deps.db, companyId, bill.sellerName, null);
      let inv = await createInvoice(deps.db, companyId, {
        customerId,
        currency: bill.currency,
        reference: `comm:${bill.sellerCompanyId}:${bill.refs.length}:${bill.totalMinor}`,
        lines: bill.lines.map((l) => ({ description: l.description, quantity: l.quantity, unitAmountMinor: l.amountMinor })),
        dueAt: new Date(Date.now() + (bill.dueDays || DEFAULT_DUE_DAYS) * 86_400_000),
        notes: [`AI3 platform commission at ${bill.pct}% of what ${bill.sellerName} collected, across ${bill.refs.length} invoice${bill.refs.length === 1 ? '' : 's'}.`, DISPUTE_CLAUSE].join('\n'),
        createdBy: 'market',
      });
      inv = await issueInvoice(deps.db, companyId, inv.id, { createdBy: 'market' });
      inv = await connectedPublish(deps, inv);
      await ai3Call(deps.fetch, settings, '/api/market/commission/issued', { companyId, refs: bill.refs, number: inv.number, url: inv.hosted?.url ?? null });
      out.commission.push({ number: inv.number, developer: bill.sellerName, total: minorToMajor(inv.totalMinor), runs: bill.refs.length });
    } catch (err) {
      out.failures.push(`commission for ${bill.sellerName}: ${message(err)}`);
    }
  }
  return out;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// The ledger's own entitlement
// ---------------------------------------------------------------------------

/** The slug the ledger is sold under on ai3.co. */
export const LEDGER_SLUG = 'ai3-ledger';

/** How long an answer stands before it is asked for again. */
const ENTITLEMENT_TTL_MS = 30 * 60 * 1000;

export interface Entitlement {
  ok: boolean;
  reason: string | null;
  /** True when this is a decision, false when it is the benefit of the doubt. */
  known: boolean;
  installUrl: string | null;
  at: number;
}

const cache = new Map<string, Entitlement>();

/** Forget what we know; for tests and for the moment an owner installs it. */
export function forgetEntitlements(): void {
  cache.clear();
}

/**
 * May this company use the parts of the ledger that are sold?
 *
 * **It fails open.** If ai3.co cannot be reached, or answers something
 * unexpected, or the company is not connected at all, the answer is yes. A
 * plugin that stops keeping a company's books because a licensing server is
 * unreachable is not a plugin anybody should install, and accounting software
 * that locks you out of your own accounts is worse than accounting software you
 * have not paid for.
 *
 * The only thing that turns it off is ai3.co saying plainly that this company is
 * not entitled.
 */
export async function ledgerEntitlement(fetch: FetchLike, settings: CompanySettings, companyId: string, now = Date.now()): Promise<Entitlement> {
  const cached = cache.get(companyId);
  if (cached && now - cached.at < ENTITLEMENT_TTL_MS) return cached;
  const open = (reason: string): Entitlement => ({ ok: true, reason, known: false, installUrl: null, at: now });
  if (!isConnected(settings)) return open('not connected to ai3.co');
  let answer: Entitlement;
  try {
    const r = (await ai3Call(fetch, settings, '/api/market/entitlement', { companyId, slug: LEDGER_SLUG })) as {
      ok?: boolean; reason?: string; installUrl?: string;
    };
    answer = { ok: r.ok === true, reason: r.reason ?? null, known: true, installUrl: r.installUrl ?? null, at: now };
  } catch (err) {
    const status = err instanceof Ai3Error ? err.status : 0;
    if (status === 402) {
      // The one answer that means no.
      answer = { ok: false, reason: (err as Ai3Error).message, known: true, installUrl: null, at: now };
    } else if (status === 404) {
      // No such listing: the ledger is not being sold here at all.
      answer = open('the ledger is not listed on this platform');
    } else {
      // Unreachable, rate limited, a bad gateway: keep the last decision if
      // there was one, and otherwise give the benefit of the doubt.
      answer = cached ? { ...cached, at: now } : open(`ai3.co did not answer (${status || 'network'})`);
    }
  }
  cache.set(companyId, answer);
  return answer;
}

/**
 * What stops when a company is not entitled.
 *
 * Never the books themselves. A company must always be able to read its own
 * accounts, pay what it owes, and take a dispute to the venue its invoices
 * name — gating any of those would trap a customer's money and, worse, stop
 * them paying the invoice that would put it right.
 *
 * What stops is the automation and the work that creates new obligations.
 */
export const ALWAYS_ALLOWED = new Set([
  // Reading the books
  'position', 'invoices', 'invoice', 'customers', 'profit-and-loss', 'balance-sheet',
  'bank-accounts', 'reconcile-queue', 'wallet', 'credits', 'stripe',
  // Paying what you owe, and recording what you were paid
  'pay-invoice', 'record-payment',
  // The venue every invoice names
  'dispute-invoice', 'dispute', 'settle-dispute',
]);

export function gatedTool(name: string): boolean {
  return !ALWAYS_ALLOWED.has(name);
}

/** What to tell an agent that asked for something the company is not paying for. */
export function notEntitledMessage(name: string, e: Entitlement): string {
  return `The AI3 Ledger is not active for this company, so ${name} is unavailable${e.reason ? ` (${e.reason})` : ''}. Reading the books, paying an invoice or a bill, and filing a dispute all still work. A person can install it at ${e.installUrl ?? 'https://ai3.co/market'}.`;
}
