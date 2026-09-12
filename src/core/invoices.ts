/**
 * Customers, invoices, receivables and payments.
 *
 * Accrual accounting, deliberately simple:
 *  - a draft changes no report. It is a document, not a transaction.
 *  - issuing posts  debit Receivables / credit Service income, dated when issued
 *  - a payment posts debit cash / credit Receivables, dated when paid
 *  - a write-off posts debit Service income / credit Receivables for what is
 *    still outstanding, so the income disappears and the receivable clears
 *  - status is derived from what has been posted, never edited by hand
 *
 * Multi-currency: the books are kept in the company's base currency; an
 * invoice may be in any currency with an exchange rate to base fixed at issue.
 * Amounts on the invoice, and what the customer owes, stay in the invoice
 * currency. The receivable is booked in base at the issue rate; a payment is
 * booked in base at the rate on the day, and the difference goes to
 * 4900 Currency gains and losses, as it does in any set of books.
 *
 * Every write is a single plain statement so the same code runs in Paperclip's
 * plugin sandbox. Nothing here knows about Paperclip.
 */
import { ACCOUNT } from './accounts.js';
import { LedgerError, findTransactionBySourceRef, postReversal, postTransaction, type EntryInput, type Subject } from './ledger.js';
import { getSettings, paymentInstructionsFor, type PaymentInstruction } from './settings.js';
import { assertCurrency, assertPositiveMinor, fromMinor, newId, table, toIso, toMinor, type LedgerDb, type Minor } from './sql.js';

export type InvoiceStatus = 'draft' | 'issued' | 'part_paid' | 'paid' | 'written_off' | 'void';

export interface Customer {
  id: string;
  publicId: string;
  companyId: string;
  name: string;
  email: string | null;
  externalRef: string | null;
  createdAt: string;
}

export interface InvoiceLineInput {
  description: string;
  quantity?: number | string;
  unitAmountMinor: Minor | number | string;
  /** Tax on the line, in the invoice currency. Added to the total and booked to 2100 Tax payable. */
  taxMinor?: Minor | number | string | null;
  /** Income account the line goes to. Defaults to 4000 Service income. */
  accountCode?: string | null;
}

export interface InvoiceLine {
  position: number;
  description: string;
  quantity: string;
  unitAmountMinor: string;
  amountMinor: string;
  taxMinor: string;
  accountCode: string | null;
}

export interface InvoicePayment {
  id: string;
  occurredAt: string;
  amountMinor: string;
  rateToBase: string;
  baseMinor: string;
  reference: string | null;
  transactionId: string | null;
}

export interface Invoice {
  id: string;
  publicId: string;
  companyId: string;
  customerId: string;
  customerName: string;
  customerEmail: string | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  baseCurrency: string;
  rateToBase: string;
  issuedAt: string | null;
  dueAt: string | null;
  reference: string | null;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  baseTotalMinor: string;
  /** Imports: what had already been paid in the previous system. */
  openingPaidMinor: string;
  /** Imported from the previous system and dated before the conversion date: issued without posting. */
  conversion: boolean;
  paidMinor: string;
  outstandingMinor: string;
  paymentMethods: PaymentInstruction[];
  notes: string | null;
  hosted: { token: string; url: string; hostedAt: string | null; sentAt: string | null; sentTo: string | null; openedAt: string | null; openCount: number } | null;
  /** How many overdue reminders have gone out (0..3) and when the last one went. */
  reminderStage: number;
  lastReminderAt: string | null;
  subject: Subject;
  createdBy: string;
  createdAt: string;
  lines: InvoiceLine[];
  payments: InvoicePayment[];
}

const ISSUE_REF = (invoiceId: string) => `invoice:${invoiceId}`;
const PAYMENT_REF = (invoiceId: string, ref: string) => `payment:${invoiceId}:${ref}`;
const WRITEOFF_REF = (invoiceId: string) => `writeoff:${invoiceId}`;

// ---------------------------------------------------------------------------
// Rates: decimal strings, ten places, integer arithmetic only.
// ---------------------------------------------------------------------------

const RATE_SCALE = 10_000_000_000n; // 1e10

export function parseRate(value: unknown): bigint {
  const s = String(value ?? '').trim();
  const m = /^(\d+)(?:\.(\d{1,10}))?$/.exec(s);
  if (!m) throw new LedgerError(`exchange rate must be a positive decimal like 1.0850, got ${s || 'nothing'}`, 'invalid');
  const scaled = BigInt(m[1]!) * RATE_SCALE + BigInt(((m[2] ?? '') + '0000000000').slice(0, 10));
  if (scaled <= 0n) throw new LedgerError('exchange rate must be positive', 'invalid');
  return scaled;
}

function rateString(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const frac = (scaled % RATE_SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** amount × rate, rounded half up to a minor unit. */
export function toBase(amountMinor: Minor, rateScaled: bigint): Minor {
  const neg = amountMinor < 0n;
  const abs = neg ? -amountMinor : amountMinor;
  const r = (abs * rateScaled + RATE_SCALE / 2n) / RATE_SCALE;
  return neg ? -r : r;
}

// ---------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------

export async function createCustomer(
  db: LedgerDb,
  companyId: string,
  input: { name: string; email?: string | null; externalRef?: string | null },
): Promise<Customer> {
  const name = String(input.name ?? '').trim();
  if (name.length < 1 || name.length > 200) throw new LedgerError('customer needs a name of 1 to 200 characters', 'invalid');
  const id = newId();
  const publicId = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'customers')} (id, public_id, company_id, name, email, external_ref)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6)`,
    [id, publicId, companyId, name, input.email?.trim() || null, input.externalRef?.trim() || null],
  );
  const c = await getCustomer(db, companyId, id);
  if (!c) throw new LedgerError('customer was not written', 'invalid');
  return c;
}

export async function getCustomer(db: LedgerDb, companyId: string, id: string): Promise<Customer | null> {
  const rows = await db.sql.query<CustomerRow>(
    `SELECT id, public_id, company_id, name, email, external_ref, created_at::text AS created_at
       FROM ${table(db, 'customers')} WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id],
  );
  const r = rows[0];
  return r ? customerFromRow(r) : null;
}

export async function listCustomers(db: LedgerDb, companyId: string): Promise<Customer[]> {
  const rows = await db.sql.query<CustomerRow>(
    `SELECT id, public_id, company_id, name, email, external_ref, created_at::text AS created_at
       FROM ${table(db, 'customers')} WHERE company_id = $1 ORDER BY name, created_at`,
    [companyId],
  );
  return rows.map(customerFromRow);
}

interface CustomerRow {
  id: string;
  public_id: string;
  company_id: string;
  name: string;
  email: string | null;
  external_ref: string | null;
  created_at: string;
}

function customerFromRow(r: CustomerRow): Customer {
  return { id: r.id, publicId: r.public_id, companyId: r.company_id, name: r.name, email: r.email, externalRef: r.external_ref, createdAt: r.created_at };
}

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

export interface CreateInvoiceInput {
  customerId: string;
  currency: string;
  /** Units of base currency per one unit of the invoice currency. Required unless the invoice is in base. */
  rateToBase?: string | number | null;
  lines: InvoiceLineInput[];
  dueAt?: Date | string | null;
  /** Which payment options to print. null or omitted: the company's defaults. */
  paymentMethodIds?: string[] | null;
  notes?: string | null;
  subject?: Subject;
  createdBy?: string;
  /** Force a number (imports). Must be unique per company. */
  number?: string | null;
  /** A purchase order or the previous system's reference. */
  reference?: string | null;
  /** Imports: what had already been paid in the previous system. */
  openingPaidMinor?: Minor | number | string | null;
  /** Imports: dated before the conversion date, so issuing posts nothing. */
  conversion?: boolean;
}

function normaliseLines(lines: InvoiceLineInput[]): Array<{ position: number; description: string; quantity: string; unit: string; amount: string; tax: string; account: string | null }> {
  if (!Array.isArray(lines) || lines.length === 0) throw new LedgerError('an invoice needs at least one line', 'invalid');
  if (lines.length > 200) throw new LedgerError('an invoice may have at most 200 lines', 'invalid');
  return lines.map((l, i) => {
    const description = String(l.description ?? '').trim();
    if (!description) throw new LedgerError(`line ${i + 1} needs a description`, 'invalid');
    const qty = Number(l.quantity ?? 1);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) throw new LedgerError(`line ${i + 1} quantity must be a positive number`, 'invalid');
    const unit = assertPositiveMinor(l.unitAmountMinor, `line ${i + 1} unit amount`);
    const qty4 = Math.round(qty * 10_000);
    const amount = (unit * BigInt(qty4) + 5_000n) / 10_000n;
    const tax = l.taxMinor === undefined || l.taxMinor === null || l.taxMinor === '' ? 0n : toMinor(l.taxMinor);
    if (tax < 0n) throw new LedgerError(`line ${i + 1} tax cannot be negative`, 'invalid');
    const account = String(l.accountCode ?? '').trim() || null;
    return { position: i + 1, description, quantity: (qty4 / 10_000).toFixed(4), unit: fromMinor(unit), amount: fromMinor(amount), tax: fromMinor(tax), account };
  });
}

/** Create a draft. A draft posts nothing and appears in no report. */
export async function createInvoice(db: LedgerDb, companyId: string, input: CreateInvoiceInput): Promise<Invoice> {
  const currency = assertCurrency(input.currency);
  const settings = await getSettings(db, companyId);
  const base = settings.baseCurrency;
  let rate = RATE_SCALE;
  if (currency !== base) {
    if (input.rateToBase === undefined || input.rateToBase === null || input.rateToBase === '') {
      throw new LedgerError(`an invoice in ${currency} needs an exchange rate to ${base} (how many ${base} for one ${currency})`, 'invalid');
    }
    rate = parseRate(input.rateToBase);
  }
  const customer = await getCustomer(db, companyId, input.customerId);
  if (!customer) throw new LedgerError(`customer ${input.customerId} not found for company ${companyId}`, 'invalid');
  const lines = normaliseLines(input.lines);
  const accounts = lines.map((l) => l.account).filter((a): a is string => Boolean(a));
  if (accounts.length) {
    const rows = await db.sql.query<{ code: string }>(`SELECT code FROM ${table(db, 'accounts')} WHERE company_id = $1 AND code = ANY(string_to_array($2::text, ','))`, [companyId, [...new Set(accounts)].join(',')]);
    const found = new Set(rows.map((r) => r.code));
    const missing = accounts.filter((a) => !found.has(a));
    if (missing.length) throw new LedgerError(`unknown account code${missing.length === 1 ? '' : 's'} ${[...new Set(missing)].join(', ')}`, 'unknown_account');
  }
  const subtotal = lines.reduce((acc, l) => acc + BigInt(l.amount), 0n);
  const tax = lines.reduce((acc, l) => acc + BigInt(l.tax), 0n);
  const total = subtotal + tax;
  const openingPaid = input.openingPaidMinor === undefined || input.openingPaidMinor === null || input.openingPaidMinor === '' ? 0n : toMinor(input.openingPaidMinor);
  if (openingPaid < 0n || openingPaid > total) throw new LedgerError('opening paid amount must be between zero and the total', 'invalid');
  const methods = await paymentInstructionsFor(db, companyId, input.paymentMethodIds ?? null);
  const id = newId();
  const publicId = newId();
  const s = input.subject ?? {};
  const forced = input.number?.trim() || null;

  let number = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    number = forced ?? (await nextInvoiceNumber(db, companyId));
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'invoices')}
         (id, public_id, company_id, customer_id, number, due_at, currency, subtotal_minor, tax_minor, total_minor, status,
          subject_work_ref, subject_goal_ref, subject_agent_ref, created_by, rate_to_base, base_currency, base_total_minor, payment_methods, notes, reference, opening_paid_minor, conversion)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::timestamptz, $7, $8::bigint, $18::bigint, $19::bigint, 'draft', $9, $10, $11, $12, $13::numeric, $14, $15::bigint, $16::jsonb, $17, $20, $21::bigint, $22::boolean)
       ON CONFLICT (company_id, number) DO NOTHING`,
      [id, publicId, companyId, customer.id, number, input.dueAt ? toIso(input.dueAt) : null, currency, fromMinor(subtotal), s.work ?? null, s.goal ?? null, s.agent ?? null,
        input.createdBy ?? 'system', rateString(rate), base, fromMinor(toBase(total, rate)), JSON.stringify(methods), input.notes?.trim().slice(0, 2000) || null,
        fromMinor(tax), fromMinor(total), input.reference?.trim().slice(0, 100) || null, fromMinor(openingPaid), input.conversion === true],
    );
    if (r.rowCount === 1) break;
    if (forced) throw new LedgerError(`an invoice numbered ${forced} already exists`, 'invalid');
    number = '';
  }
  if (!number) throw new LedgerError('could not allocate an invoice number', 'invalid');

  const written = await db.sql.execute(
    `INSERT INTO ${table(db, 'invoice_lines')} (id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor, tax_minor, account_code)
     SELECT gen_random_uuid(), $1::uuid, l.position, l.description, l.quantity, l.unit, l.amount, l.tax, l.account
       FROM jsonb_to_recordset($2::jsonb) AS l(position int, description text, quantity numeric, unit bigint, amount bigint, tax bigint, account text)`,
    [id, JSON.stringify(lines)],
  );
  if (written.rowCount !== lines.length) {
    await db.sql.execute(`DELETE FROM ${table(db, 'invoice_lines')} WHERE invoice_id = $1::uuid`, [id]);
    await db.sql.execute(`DELETE FROM ${table(db, 'invoices')} WHERE id = $1::uuid AND status = 'draft'`, [id]);
    throw new LedgerError('invoice lines were not written', 'invalid');
  }
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError('invoice was not written', 'invalid');
  return inv;
}

async function nextInvoiceNumber(db: LedgerDb, companyId: string): Promise<string> {
  const rows = await db.sql.query<{ n: unknown }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '^INV-', ''), '')::int), 0) + 1 AS n
       FROM ${table(db, 'invoices')} WHERE company_id = $1 AND number ~ '^INV-[0-9]+$'`,
    [companyId],
  );
  const n = Number(rows[0]?.n ?? 1);
  return `INV-${String(n).padStart(4, '0')}`;
}

interface InvoiceRow {
  id: string;
  public_id: string;
  company_id: string;
  customer_id: string;
  customer_name: string;
  customer_email: string | null;
  number: string;
  status: InvoiceStatus;
  currency: string;
  base_currency: string | null;
  rate_to_base: string;
  issued_at: string | null;
  due_at: string | null;
  reference: string | null;
  subtotal_minor: unknown;
  tax_minor: unknown;
  total_minor: unknown;
  base_total_minor: unknown;
  opening_paid_minor: unknown;
  conversion: boolean;
  paid_minor: unknown;
  payment_methods: unknown;
  notes: string | null;
  hosted_token: string | null;
  hosted_url: string | null;
  hosted_at: string | null;
  sent_at: string | null;
  sent_to: string | null;
  opened_at: string | null;
  open_count: unknown;
  reminder_stage: unknown;
  last_reminder_at: string | null;
  subject_work_ref: string | null;
  subject_goal_ref: string | null;
  subject_agent_ref: string | null;
  created_by: string;
  created_at: string;
}

const INVOICE_SELECT = (db: LedgerDb) => `
  SELECT i.id, i.public_id, i.company_id, i.customer_id, c.name AS customer_name, c.email AS customer_email, i.number, i.status, i.currency,
         i.base_currency, i.rate_to_base::text AS rate_to_base,
         i.issued_at::text AS issued_at, i.due_at::text AS due_at, i.reference, i.subtotal_minor, i.tax_minor, i.total_minor, i.base_total_minor, i.opening_paid_minor, i.conversion, i.payment_methods, i.notes,
         i.hosted_token, i.hosted_url, i.hosted_at::text AS hosted_at, i.sent_at::text AS sent_at, i.sent_to, i.opened_at::text AS opened_at, i.open_count, i.reminder_stage, i.last_reminder_at::text AS last_reminder_at,
         i.subject_work_ref, i.subject_goal_ref, i.subject_agent_ref, i.created_by, i.created_at::text AS created_at,
         COALESCE((SELECT SUM(p.amount_minor) FROM ${table(db, 'invoice_payments')} p WHERE p.invoice_id = i.id AND p.transaction_id IS NOT NULL), 0) AS paid_minor
    FROM ${table(db, 'invoices')} i JOIN ${table(db, 'customers')} c ON c.id = i.customer_id`;

export async function getInvoice(db: LedgerDb, companyId: string, id: string): Promise<Invoice | null> {
  const rows = await db.sql.query<InvoiceRow>(`${INVOICE_SELECT(db)} WHERE i.company_id = $1 AND i.id = $2::uuid`, [companyId, id]);
  const r = rows[0];
  if (!r) return null;
  const lines = await db.sql.query<{ position: number; description: string; quantity: string; unit_amount_minor: unknown; amount_minor: unknown; tax_minor: unknown; account_code: string | null }>(
    `SELECT position, description, quantity::text AS quantity, unit_amount_minor, amount_minor, tax_minor, account_code
       FROM ${table(db, 'invoice_lines')} WHERE invoice_id = $1::uuid ORDER BY position`,
    [id],
  );
  const payments = await db.sql.query<{ id: string; occurred_at: string; amount_minor: unknown; rate_to_base: string; base_minor: unknown; reference: string | null; transaction_id: string | null }>(
    `SELECT id, occurred_at::text AS occurred_at, amount_minor, rate_to_base::text AS rate_to_base, base_minor, reference, transaction_id
       FROM ${table(db, 'invoice_payments')} WHERE invoice_id = $1::uuid AND transaction_id IS NOT NULL ORDER BY occurred_at`,
    [id],
  );
  return invoiceFromRow(
    r,
    lines.map((l) => ({ position: Number(l.position), description: l.description, quantity: String(l.quantity), unitAmountMinor: fromMinor(toMinor(l.unit_amount_minor)), amountMinor: fromMinor(toMinor(l.amount_minor)), taxMinor: fromMinor(toMinor(l.tax_minor ?? 0)), accountCode: l.account_code })),
    payments.map((p) => ({ id: p.id, occurredAt: p.occurred_at, amountMinor: fromMinor(toMinor(p.amount_minor)), rateToBase: p.rate_to_base, baseMinor: fromMinor(toMinor(p.base_minor)), reference: p.reference, transactionId: p.transaction_id })),
  );
}

export async function listInvoices(db: LedgerDb, companyId: string, opts: { status?: InvoiceStatus; customerId?: string; limit?: number } = {}): Promise<Invoice[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 100), 1), 500);
  const rows = await db.sql.query<InvoiceRow>(
    `${INVOICE_SELECT(db)}
      WHERE i.company_id = $1
        AND ($2::text IS NULL OR i.status = $2::text)
        AND ($3::uuid IS NULL OR i.customer_id = $3::uuid)
      ORDER BY i.created_at DESC
      LIMIT $4::int`,
    [companyId, opts.status ?? null, opts.customerId ?? null, limit],
  );
  return rows.map((r) => invoiceFromRow(r, [], []));
}

function invoiceFromRow(r: InvoiceRow, lines: InvoiceLine[], payments: InvoicePayment[]): Invoice {
  const total = toMinor(r.total_minor);
  const paid = toMinor(r.paid_minor);
  const opening = toMinor(r.opening_paid_minor ?? 0);
  const outstanding = r.status === 'written_off' || r.status === 'void' || r.status === 'draft' ? 0n : total - opening - paid;
  let methods: PaymentInstruction[] = [];
  try { methods = typeof r.payment_methods === 'string' ? (JSON.parse(r.payment_methods) as PaymentInstruction[]) : ((r.payment_methods as PaymentInstruction[]) ?? []); } catch { methods = []; }
  return {
    id: r.id,
    publicId: r.public_id,
    companyId: r.company_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    customerEmail: r.customer_email,
    number: r.number,
    status: r.status,
    currency: r.currency,
    baseCurrency: r.base_currency ?? r.currency,
    rateToBase: rateString(parseRate(r.rate_to_base ?? '1')),
    issuedAt: r.issued_at,
    dueAt: r.due_at,
    reference: r.reference ?? null,
    subtotalMinor: fromMinor(r.subtotal_minor === null || r.subtotal_minor === undefined ? total : toMinor(r.subtotal_minor)),
    taxMinor: fromMinor(toMinor(r.tax_minor ?? 0)),
    totalMinor: fromMinor(total),
    baseTotalMinor: fromMinor(r.base_total_minor === null || r.base_total_minor === undefined ? total : toMinor(r.base_total_minor)),
    openingPaidMinor: fromMinor(opening),
    conversion: r.conversion === true,
    paidMinor: fromMinor(paid),
    outstandingMinor: fromMinor(outstanding < 0n ? 0n : outstanding),
    paymentMethods: Array.isArray(methods) ? methods : [],
    notes: r.notes,
    hosted: r.hosted_token && r.hosted_url ? { token: r.hosted_token, url: r.hosted_url, hostedAt: r.hosted_at, sentAt: r.sent_at, sentTo: r.sent_to, openedAt: r.opened_at, openCount: Number(r.open_count ?? 0) } : null,
    reminderStage: Number(r.reminder_stage ?? 0),
    lastReminderAt: r.last_reminder_at,
    subject: {
      ...(r.subject_agent_ref ? { agent: r.subject_agent_ref } : {}),
      ...(r.subject_goal_ref ? { goal: r.subject_goal_ref } : {}),
      ...(r.subject_work_ref ? { work: r.subject_work_ref } : {}),
    },
    createdBy: r.created_by,
    createdAt: r.created_at,
    lines,
    payments,
  };
}

async function setStatus(db: LedgerDb, companyId: string, id: string, from: InvoiceStatus[], to: InvoiceStatus, issuedAt?: string): Promise<void> {
  await db.sql.execute(
    `UPDATE ${table(db, 'invoices')}
        SET status = $3, issued_at = COALESCE($4::timestamptz, issued_at)
      WHERE company_id = $1 AND id = $2::uuid AND status = ANY(string_to_array($5::text, ','))`,
    [companyId, id, to, issuedAt ?? null, from.join(',')],
  );
}

/** Change the payment options printed on a draft. */
export async function setInvoicePaymentMethods(db: LedgerDb, companyId: string, id: string, ids: string[] | null): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status !== 'draft') throw new LedgerError('payment options can only change on a draft', 'invalid');
  const methods = await paymentInstructionsFor(db, companyId, ids);
  await db.sql.execute(`UPDATE ${table(db, 'invoices')} SET payment_methods = $3::jsonb WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`, [companyId, id, JSON.stringify(methods)]);
  return (await getInvoice(db, companyId, id)) ?? inv;
}

/** Issue a draft: the only step that books revenue, and only a person may call it. Idempotent. */
export async function issueInvoice(
  db: LedgerDb,
  companyId: string,
  id: string,
  opts: { issuedAt?: Date | string; createdBy?: string } = {},
): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status !== 'draft') {
    if (inv.status === 'void') throw new LedgerError(`invoice ${inv.number} is void`, 'invalid');
    return inv;
  }
  const baseTotal = toMinor(inv.baseTotalMinor);
  if (baseTotal <= 0n) throw new LedgerError(`invoice ${inv.number} has no amount`, 'invalid');
  // Refresh the printed payment options from the current definitions of the ones chosen.
  const chosen = inv.paymentMethods.map((m) => m.id);
  const methods = await paymentInstructionsFor(db, companyId, chosen.length ? chosen : null);
  await db.sql.execute(`UPDATE ${table(db, 'invoices')} SET payment_methods = $3::jsonb WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`, [companyId, id, JSON.stringify(methods)]);
  const issuedAt = toIso(opts.issuedAt ?? new Date());
  const fx = inv.currency !== inv.baseCurrency ? ` (${inv.currency} ${fromMinor(toMinor(inv.totalMinor))} at ${inv.rateToBase})` : '';
  if (!inv.conversion) {
    // Income per account (default 4000), tax to 2100; the last income line takes the rounding so credits equal the receivable.
    const rate = parseRate(inv.rateToBase);
    const byAccount = new Map<string, Minor>();
    for (const l of inv.lines) {
      const code = l.accountCode ?? ACCOUNT.SERVICE_INCOME;
      byAccount.set(code, (byAccount.get(code) ?? 0n) + toMinor(l.amountMinor));
    }
    const taxBase = toBase(toMinor(inv.taxMinor), rate);
    const entries: EntryInput[] = [{ accountCode: ACCOUNT.RECEIVABLES, direction: 'debit', amountMinor: baseTotal, subject: inv.subject }];
    let credited = 0n;
    const codes = [...byAccount.keys()];
    codes.forEach((code, i) => {
      const last = i === codes.length - 1;
      const amount = last ? baseTotal - taxBase - credited : toBase(byAccount.get(code)!, rate);
      credited += amount;
      if (amount > 0n) entries.push({ accountCode: code, direction: 'credit', amountMinor: amount, subject: inv.subject });
    });
    if (taxBase > 0n) entries.push({ accountCode: ACCOUNT.TAX_PAYABLE, direction: 'credit', amountMinor: taxBase, subject: inv.subject });
    await postTransaction(db, {
      companyId,
      occurredAt: issuedAt,
      description: `Invoice ${inv.number} · ${inv.customerName}${fx}`,
      sourcePlatform: 'manual',
      sourceKind: 'invoice',
      sourceRef: ISSUE_REF(inv.id),
      currency: inv.baseCurrency,
      createdBy: opts.createdBy ?? 'board',
      entries,
    });
  }
  const opening = toMinor(inv.openingPaidMinor);
  const first: InvoiceStatus = opening >= toMinor(inv.totalMinor) ? 'paid' : opening > 0n ? 'part_paid' : 'issued';
  await setStatus(db, companyId, id, ['draft'], first, issuedAt);
  const after = await getInvoice(db, companyId, id);
  if (!after) throw new LedgerError('invoice vanished while issuing', 'invalid');
  return after;
}

/**
 * Record money received against an issued invoice, in the invoice currency.
 * Partials allowed; overpayment refused. In base currency the cash is booked at
 * the rate on the day and the receivable is relieved at the issue rate; the
 * difference is a currency gain or loss.
 */
export async function recordPayment(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { amountMinor: Minor | number | string; occurredAt?: Date | string; reference?: string | null; createdBy?: string; cashAccountCode?: string; rateToBase?: string | number | null },
): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status !== 'issued' && inv.status !== 'part_paid') {
    throw new LedgerError(`invoice ${inv.number} is ${inv.status}; only an issued invoice can be paid`, 'invalid');
  }
  const amount = assertPositiveMinor(input.amountMinor, 'payment amount');
  const outstanding = toMinor(inv.outstandingMinor);
  if (amount > outstanding) {
    throw new LedgerError(`payment ${fromMinor(amount)} exceeds the ${fromMinor(outstanding)} outstanding on ${inv.number}`, 'invalid');
  }
  const issueRate = parseRate(inv.rateToBase);
  const payRate = input.rateToBase === undefined || input.rateToBase === null || input.rateToBase === '' ? issueRate : parseRate(input.rateToBase);
  const cashBase = toBase(amount, payRate);
  // Relieve the receivable in proportion; the last payment takes whatever is left so rounding never strands a cent.
  const owedBase = toBase(toMinor(inv.totalMinor) - toMinor(inv.openingPaidMinor), issueRate);
  const remainingBase = owedBase - inv.payments.reduce((s, p) => s + toBase(toMinor(p.amountMinor), issueRate), 0n);
  const reliefBase = amount === outstanding ? remainingBase : toBase(amount, issueRate);
  const diff = cashBase - reliefBase; // positive: gain
  const ref = (input.reference ?? '').trim() || newId();
  const occurredAt = toIso(input.occurredAt ?? new Date());

  const paymentId = newId();
  const inserted = await db.sql.execute(
    `INSERT INTO ${table(db, 'invoice_payments')} (id, company_id, invoice_id, occurred_at, amount_minor, rate_to_base, base_minor, reference)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::bigint, $6::numeric, $7::bigint, $8)
     ON CONFLICT (invoice_id, reference) DO NOTHING`,
    [paymentId, companyId, inv.id, occurredAt, fromMinor(amount), rateString(payRate), fromMinor(cashBase), ref],
  );
  if (inserted.rowCount === 0) return inv; // same reference twice: a no-op

  const entries: EntryInput[] = [
    { accountCode: input.cashAccountCode ?? ACCOUNT.TREASURY, direction: 'debit' as const, amountMinor: cashBase, subject: inv.subject },
    { accountCode: ACCOUNT.RECEIVABLES, direction: 'credit' as const, amountMinor: reliefBase, subject: inv.subject },
  ];
  if (diff > 0n) entries.push({ accountCode: ACCOUNT.CURRENCY_GAINS, direction: 'credit' as const, amountMinor: diff, subject: inv.subject });
  if (diff < 0n) entries.push({ accountCode: ACCOUNT.CURRENCY_GAINS, direction: 'debit' as const, amountMinor: -diff, subject: inv.subject });
  const fx = inv.currency !== inv.baseCurrency ? ` (${inv.currency} ${fromMinor(amount)} at ${rateString(payRate)})` : '';
  const r = await postTransaction(db, {
    companyId,
    occurredAt,
    description: `Payment on ${inv.number} · ${inv.customerName}${fx}`,
    sourcePlatform: 'manual',
    sourceKind: 'payment',
    sourceRef: PAYMENT_REF(inv.id, ref),
    currency: inv.baseCurrency,
    createdBy: input.createdBy ?? 'board',
    entries,
  });
  await db.sql.execute(`UPDATE ${table(db, 'invoice_payments')} SET transaction_id = $2::uuid WHERE id = $1::uuid`, [paymentId, r.transactionId]);
  const after = await getInvoice(db, companyId, id);
  if (!after) throw new LedgerError('invoice vanished while paying', 'invalid');
  const next: InvoiceStatus = toMinor(after.outstandingMinor) === 0n ? 'paid' : 'part_paid';
  await setStatus(db, companyId, id, ['issued', 'part_paid'], next);
  return (await getInvoice(db, companyId, id)) ?? after;
}

/** Give up on what is still outstanding: income comes back out, the receivable clears. */
export async function writeOffInvoice(
  db: LedgerDb,
  companyId: string,
  id: string,
  opts: { occurredAt?: Date | string; createdBy?: string; reason?: string } = {},
): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status !== 'issued' && inv.status !== 'part_paid') {
    throw new LedgerError(`invoice ${inv.number} is ${inv.status}; only an issued invoice can be written off`, 'invalid');
  }
  const issueRate = parseRate(inv.rateToBase);
  const remainingBase = toBase(toMinor(inv.totalMinor) - toMinor(inv.openingPaidMinor), issueRate) - inv.payments.reduce((s, p) => s + toBase(toMinor(p.amountMinor), issueRate), 0n);
  if (remainingBase > 0n) {
    await postTransaction(db, {
      companyId,
      occurredAt: toIso(opts.occurredAt ?? new Date()),
      description: `Write-off of ${inv.number} · ${inv.customerName}${opts.reason ? ` · ${opts.reason}` : ''}`,
      sourcePlatform: 'manual',
      sourceKind: 'invoice',
      sourceRef: WRITEOFF_REF(inv.id),
      currency: inv.baseCurrency,
      createdBy: opts.createdBy ?? 'board',
      entries: [
        { accountCode: ACCOUNT.SERVICE_INCOME, direction: 'debit', amountMinor: remainingBase, subject: inv.subject },
        { accountCode: ACCOUNT.RECEIVABLES, direction: 'credit', amountMinor: remainingBase, subject: inv.subject },
      ],
    });
  }
  await setStatus(db, companyId, id, ['issued', 'part_paid'], 'written_off');
  const after = await getInvoice(db, companyId, id);
  if (!after) throw new LedgerError('invoice vanished while writing off', 'invalid');
  return after;
}

/** Void a draft. Nothing was ever posted, so nothing is reversed. */
/**
 * Cancel an invoice raised in error. A draft is simply voided. An issued
 * invoice with nothing paid on it is reversed: the issue posting gets a
 * reversing transaction, so the receivable and the income disappear and the
 * ledger stays append-only. Anything with a payment on it cannot be voided;
 * write it off or refund it.
 */
export async function voidInvoice(db: LedgerDb, companyId: string, id: string, opts: { createdBy?: string; reason?: string } = {}): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status === 'draft') {
    await setStatus(db, companyId, id, ['draft'], 'void');
    return (await getInvoice(db, companyId, id)) ?? { ...inv, status: 'void' };
  }
  if (toMinor(inv.paidMinor) !== 0n) throw new LedgerError(`${inv.number} has payments on it; write it off or refund it instead`, 'invalid');
  if (inv.status !== 'issued') throw new LedgerError(`${inv.number} is ${inv.status}; only a draft or an unpaid issued invoice can be voided`, 'invalid');
  const issueTx = await findTransactionBySourceRef(db, companyId, 'manual', ISSUE_REF(inv.id));
  if (issueTx) {
    await postReversal(db, companyId, issueTx, { description: `Void ${inv.number}${opts.reason ? ` · ${opts.reason}` : ''}`, createdBy: opts.createdBy ?? 'board' });
  }
  await setStatus(db, companyId, id, ['issued'], 'void');
  return (await getInvoice(db, companyId, id)) ?? { ...inv, status: 'void' };
}

/** Record where the invoice is hosted. */
export async function setInvoiceHosted(db: LedgerDb, companyId: string, id: string, hosted: { token: string; url: string }): Promise<void> {
  await db.sql.execute(`UPDATE ${table(db, 'invoices')} SET hosted_token = $3, hosted_url = $4, hosted_at = COALESCE(hosted_at, now()) WHERE company_id = $1 AND id = $2::uuid`, [companyId, id, hosted.token, hosted.url]);
}

export async function markInvoiceSent(db: LedgerDb, companyId: string, id: string, to: string): Promise<void> {
  await db.sql.execute(`UPDATE ${table(db, 'invoices')} SET sent_at = now(), sent_to = $3 WHERE company_id = $1 AND id = $2::uuid`, [companyId, id, to.slice(0, 500)]);
}

/** Record that reminder number `stage` went out. */
export async function markInvoiceReminded(db: LedgerDb, companyId: string, id: string, stage: number): Promise<void> {
  await db.sql.execute(`UPDATE ${table(db, 'invoices')} SET reminder_stage = $3::int, last_reminder_at = now() WHERE company_id = $1 AND id = $2::uuid`, [companyId, id, stage]);
}

export async function markInvoiceOpened(db: LedgerDb, companyId: string, id: string, openedAt: string, openCount: number): Promise<void> {
  await db.sql.execute(`UPDATE ${table(db, 'invoices')} SET opened_at = COALESCE(opened_at, $3::timestamptz), open_count = $4::int WHERE company_id = $1 AND id = $2::uuid`, [companyId, id, openedAt, openCount]);
}

/** Sum of what is outstanding on issued and part-paid invoices, in base currency at the issue rates. */
export async function receivablesOutstanding(db: LedgerDb, companyId: string): Promise<Minor> {
  const open = (await listInvoices(db, companyId, { limit: 500 })).filter((i) => i.status === 'issued' || i.status === 'part_paid');
  return open.reduce((acc, i) => acc + toBase(toMinor(i.outstandingMinor), parseRate(i.rateToBase)), 0n);
}
