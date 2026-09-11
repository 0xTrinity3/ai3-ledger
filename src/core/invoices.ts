/**
 * Customers, invoices, receivables and payments (M3).
 *
 * Accrual accounting, deliberately simple:
 *  - a draft changes no report. It is a document, not a transaction.
 *  - issuing posts  debit Receivables / credit Service income, dated when issued
 *  - a payment posts debit Treasury / credit Receivables, dated when paid
 *  - a write-off posts debit Service income / credit Receivables for what is
 *    still outstanding, so the income disappears and the receivable clears
 *  - status is derived from what has been posted, never edited by hand
 *
 * Every write is a single plain statement so the same code runs in Paperclip's
 * plugin sandbox. Nothing here knows about Paperclip.
 */
import { ACCOUNT } from './accounts.js';
import { LedgerError, postTransaction, type Subject } from './ledger.js';
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
}

export interface InvoiceLine {
  position: number;
  description: string;
  quantity: string;
  unitAmountMinor: string;
  amountMinor: string;
}

export interface Invoice {
  id: string;
  publicId: string;
  companyId: string;
  customerId: string;
  customerName: string;
  number: string;
  status: InvoiceStatus;
  currency: string;
  issuedAt: string | null;
  dueAt: string | null;
  totalMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  subject: Subject;
  createdBy: string;
  createdAt: string;
  lines: InvoiceLine[];
}

const ISSUE_REF = (invoiceId: string) => `invoice:${invoiceId}`;
const PAYMENT_REF = (invoiceId: string, ref: string) => `payment:${invoiceId}:${ref}`;
const WRITEOFF_REF = (invoiceId: string) => `writeoff:${invoiceId}`;

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
  lines: InvoiceLineInput[];
  dueAt?: Date | string | null;
  subject?: Subject;
  createdBy?: string;
}

function normaliseLines(lines: InvoiceLineInput[]): Array<{ position: number; description: string; quantity: string; unit: string; amount: string }> {
  if (!Array.isArray(lines) || lines.length === 0) throw new LedgerError('an invoice needs at least one line', 'invalid');
  if (lines.length > 200) throw new LedgerError('an invoice may have at most 200 lines', 'invalid');
  return lines.map((l, i) => {
    const description = String(l.description ?? '').trim();
    if (!description) throw new LedgerError(`line ${i + 1} needs a description`, 'invalid');
    const qty = Number(l.quantity ?? 1);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) throw new LedgerError(`line ${i + 1} quantity must be a positive number`, 'invalid');
    const unit = assertPositiveMinor(l.unitAmountMinor, `line ${i + 1} unit amount`);
    // quantity is kept to four decimals; the line amount is rounded half up to a minor unit
    const qty4 = Math.round(qty * 10_000);
    const amount = (unit * BigInt(qty4) + 5_000n) / 10_000n;
    return { position: i + 1, description, quantity: (qty4 / 10_000).toFixed(4), unit: fromMinor(unit), amount: fromMinor(amount) };
  });
}

/** Create a draft. A draft posts nothing and appears in no report. */
export async function createInvoice(db: LedgerDb, companyId: string, input: CreateInvoiceInput): Promise<Invoice> {
  const currency = assertCurrency(input.currency);
  const customer = await getCustomer(db, companyId, input.customerId);
  if (!customer) throw new LedgerError(`customer ${input.customerId} not found for company ${companyId}`, 'invalid');
  const lines = normaliseLines(input.lines);
  const total = lines.reduce((acc, l) => acc + BigInt(l.amount), 0n);
  const id = newId();
  const publicId = newId();
  const s = input.subject ?? {};

  // Numbering: INV-0001 upwards per company. Unique on (company, number); on a
  // race the insert writes nothing and we try the next number.
  let number = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    number = await nextInvoiceNumber(db, companyId);
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'invoices')}
         (id, public_id, company_id, customer_id, number, due_at, currency, subtotal_minor, total_minor, status,
          subject_work_ref, subject_goal_ref, subject_agent_ref, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6::timestamptz, $7, $8::bigint, $8::bigint, 'draft', $9, $10, $11, $12)
       ON CONFLICT (company_id, number) DO NOTHING`,
      [id, publicId, companyId, customer.id, number, input.dueAt ? toIso(input.dueAt) : null, currency, fromMinor(total), s.work ?? null, s.goal ?? null, s.agent ?? null, input.createdBy ?? 'system'],
    );
    if (r.rowCount === 1) break;
    number = '';
  }
  if (!number) throw new LedgerError('could not allocate an invoice number', 'invalid');

  const written = await db.sql.execute(
    `INSERT INTO ${table(db, 'invoice_lines')} (id, invoice_id, position, description, quantity, unit_amount_minor, amount_minor)
     SELECT gen_random_uuid(), $1::uuid, l.position, l.description, l.quantity, l.unit, l.amount
       FROM jsonb_to_recordset($2::jsonb) AS l(position int, description text, quantity numeric, unit bigint, amount bigint)`,
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
  number: string;
  status: InvoiceStatus;
  currency: string;
  issued_at: string | null;
  due_at: string | null;
  total_minor: unknown;
  paid_minor: unknown;
  subject_work_ref: string | null;
  subject_goal_ref: string | null;
  subject_agent_ref: string | null;
  created_by: string;
  created_at: string;
}

const INVOICE_SELECT = (db: LedgerDb) => `
  SELECT i.id, i.public_id, i.company_id, i.customer_id, c.name AS customer_name, i.number, i.status, i.currency,
         i.issued_at::text AS issued_at, i.due_at::text AS due_at, i.total_minor,
         i.subject_work_ref, i.subject_goal_ref, i.subject_agent_ref, i.created_by, i.created_at::text AS created_at,
         COALESCE((
           SELECT SUM(e.amount_minor)
             FROM ${table(db, 'transactions')} t
             JOIN ${table(db, 'entries')} e ON e.transaction_id = t.id
             JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
            WHERE t.company_id = i.company_id AND t.status = 'posted' AND t.source_kind = 'payment'
              AND t.source_ref LIKE 'payment:' || i.id::text || ':%'
              AND a.code = '${ACCOUNT.RECEIVABLES}' AND e.direction = 'credit'
         ), 0) AS paid_minor
    FROM ${table(db, 'invoices')} i JOIN ${table(db, 'customers')} c ON c.id = i.customer_id`;

export async function getInvoice(db: LedgerDb, companyId: string, id: string): Promise<Invoice | null> {
  const rows = await db.sql.query<InvoiceRow>(`${INVOICE_SELECT(db)} WHERE i.company_id = $1 AND i.id = $2::uuid`, [companyId, id]);
  const r = rows[0];
  if (!r) return null;
  const lines = await db.sql.query<{ position: number; description: string; quantity: string; unit_amount_minor: unknown; amount_minor: unknown }>(
    `SELECT position, description, quantity::text AS quantity, unit_amount_minor, amount_minor
       FROM ${table(db, 'invoice_lines')} WHERE invoice_id = $1::uuid ORDER BY position`,
    [id],
  );
  return invoiceFromRow(r, lines.map((l) => ({
    position: Number(l.position),
    description: l.description,
    quantity: String(l.quantity),
    unitAmountMinor: fromMinor(toMinor(l.unit_amount_minor)),
    amountMinor: fromMinor(toMinor(l.amount_minor)),
  })));
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
  return rows.map((r) => invoiceFromRow(r, []));
}

function invoiceFromRow(r: InvoiceRow, lines: InvoiceLine[]): Invoice {
  const total = toMinor(r.total_minor);
  const paid = toMinor(r.paid_minor);
  const outstanding = r.status === 'written_off' || r.status === 'void' || r.status === 'draft' ? 0n : total - paid;
  return {
    id: r.id,
    publicId: r.public_id,
    companyId: r.company_id,
    customerId: r.customer_id,
    customerName: r.customer_name,
    number: r.number,
    status: r.status,
    currency: r.currency,
    issuedAt: r.issued_at,
    dueAt: r.due_at,
    totalMinor: fromMinor(total),
    paidMinor: fromMinor(paid),
    outstandingMinor: fromMinor(outstanding < 0n ? 0n : outstanding),
    subject: {
      ...(r.subject_agent_ref ? { agent: r.subject_agent_ref } : {}),
      ...(r.subject_goal_ref ? { goal: r.subject_goal_ref } : {}),
      ...(r.subject_work_ref ? { work: r.subject_work_ref } : {}),
    },
    createdBy: r.created_by,
    createdAt: r.created_at,
    lines,
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
    return inv; // already issued (or beyond): nothing to do
  }
  const total = toMinor(inv.totalMinor);
  if (total <= 0n) throw new LedgerError(`invoice ${inv.number} has no amount`, 'invalid');
  const issuedAt = toIso(opts.issuedAt ?? new Date());
  await postTransaction(db, {
    companyId,
    occurredAt: issuedAt,
    description: `Invoice ${inv.number} · ${inv.customerName}`,
    sourcePlatform: 'manual',
    sourceKind: 'invoice',
    sourceRef: ISSUE_REF(inv.id),
    currency: inv.currency,
    createdBy: opts.createdBy ?? 'board',
    entries: [
      { accountCode: ACCOUNT.RECEIVABLES, direction: 'debit', amountMinor: total, subject: inv.subject },
      { accountCode: ACCOUNT.SERVICE_INCOME, direction: 'credit', amountMinor: total, subject: inv.subject },
    ],
  });
  await setStatus(db, companyId, id, ['draft'], 'issued', issuedAt);
  const after = await getInvoice(db, companyId, id);
  if (!after) throw new LedgerError('invoice vanished while issuing', 'invalid');
  return after;
}

/** Record money received against an issued invoice. Partials allowed; overpayment refused. */
export async function recordPayment(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { amountMinor: Minor | number | string; occurredAt?: Date | string; reference?: string | null; createdBy?: string },
): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status !== 'issued' && inv.status !== 'part_paid') {
    throw new LedgerError(`invoice ${inv.number} is ${inv.status}; only an issued invoice can be paid`, 'invalid');
  }
  const amount = assertPositiveMinor(input.amountMinor, 'payment amount');
  const outstanding = toMinor(inv.outstandingMinor);
  if (amount > outstanding) {
    throw new LedgerError(`payment ${amount} exceeds the ${outstanding} outstanding on ${inv.number}`, 'invalid');
  }
  const ref = (input.reference ?? '').trim() || newId();
  const occurredAt = toIso(input.occurredAt ?? new Date());
  await postTransaction(db, {
    companyId,
    occurredAt,
    description: `Payment on ${inv.number} · ${inv.customerName}`,
    sourcePlatform: 'manual',
    sourceKind: 'payment',
    sourceRef: PAYMENT_REF(inv.id, ref),
    currency: inv.currency,
    createdBy: input.createdBy ?? 'board',
    entries: [
      { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: amount, subject: inv.subject },
      { accountCode: ACCOUNT.RECEIVABLES, direction: 'credit', amountMinor: amount, subject: inv.subject },
    ],
  });
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
  const outstanding = toMinor(inv.outstandingMinor);
  if (outstanding > 0n) {
    await postTransaction(db, {
      companyId,
      occurredAt: toIso(opts.occurredAt ?? new Date()),
      description: `Write-off of ${inv.number} · ${inv.customerName}${opts.reason ? ` · ${opts.reason}` : ''}`,
      sourcePlatform: 'manual',
      sourceKind: 'invoice',
      sourceRef: WRITEOFF_REF(inv.id),
      currency: inv.currency,
      createdBy: opts.createdBy ?? 'board',
      entries: [
        { accountCode: ACCOUNT.SERVICE_INCOME, direction: 'debit', amountMinor: outstanding, subject: inv.subject },
        { accountCode: ACCOUNT.RECEIVABLES, direction: 'credit', amountMinor: outstanding, subject: inv.subject },
      ],
    });
  }
  await setStatus(db, companyId, id, ['issued', 'part_paid'], 'written_off');
  const after = await getInvoice(db, companyId, id);
  if (!after) throw new LedgerError('invoice vanished while writing off', 'invalid');
  return after;
}

/** Void a draft. Nothing was ever posted, so nothing is reversed. */
export async function voidInvoice(db: LedgerDb, companyId: string, id: string): Promise<Invoice> {
  const inv = await getInvoice(db, companyId, id);
  if (!inv) throw new LedgerError(`invoice ${id} not found for company ${companyId}`, 'invalid');
  if (inv.status !== 'draft') throw new LedgerError(`only a draft can be voided; ${inv.number} is ${inv.status}`, 'invalid');
  await setStatus(db, companyId, id, ['draft'], 'void');
  return (await getInvoice(db, companyId, id)) ?? { ...inv, status: 'void' };
}

/** Sum of what is outstanding on issued and part-paid invoices. Must equal the Receivables balance. */
export async function receivablesOutstanding(db: LedgerDb, companyId: string): Promise<Minor> {
  const open = await listInvoices(db, companyId, { limit: 500 });
  return open.filter((i) => i.status === 'issued' || i.status === 'part_paid').reduce((acc, i) => acc + toMinor(i.outstandingMinor), 0n);
}
