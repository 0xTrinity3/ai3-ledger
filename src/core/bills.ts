/**
 * Suppliers, bills, payables and bill payments: the purchase side, the mirror
 * of invoices.ts.
 *
 *  - a draft bill is a document and changes no report
 *  - approving posts debit expense (per line's account) and debit Tax payable
 *    for any tax, credit Payables, dated the bill date
 *  - a payment posts debit Payables / credit the bank account
 *  - voiding an approved bill with nothing paid reverses the approval
 *  - status is derived from what has been posted, never edited by hand
 *
 * Multi-currency works as it does for invoices: the payable is booked in base
 * at the bill's rate, a payment at the rate on the day, the difference to 4900.
 * A conversion bill (imported from the previous system, dated before the
 * conversion date) is approved without posting: its payable is already inside
 * the imported trial balance.
 */
import { ACCOUNT } from './accounts.js';
import { LedgerError, findTransactionBySourceRef, postReversal, postTransaction, type EntryInput, type Subject } from './ledger.js';
import { parseRate, toBase } from './invoices.js';
import { getSettings } from './settings.js';
import { assertCurrency, assertPositiveMinor, fromMinor, newId, table, toIso, toMinor, type LedgerDb, type Minor } from './sql.js';

export type BillStatus = 'draft' | 'approved' | 'part_paid' | 'paid' | 'void';

export interface Supplier {
  id: string;
  publicId: string;
  companyId: string;
  name: string;
  email: string | null;
  externalRef: string | null;
  defaultAccountCode: string | null;
  createdAt: string;
}

export interface BillLineInput {
  description: string;
  quantity?: number | string;
  unitAmountMinor: Minor | number | string;
  taxMinor?: Minor | number | string | null;
  /** Expense (or asset) account the line goes to. Defaults to the supplier's default, then 5900. */
  accountCode?: string | null;
}

export interface BillLine {
  position: number;
  description: string;
  quantity: string;
  unitAmountMinor: string;
  amountMinor: string;
  taxMinor: string;
  accountCode: string;
  accountName: string;
}

export interface BillPayment {
  id: string;
  occurredAt: string;
  amountMinor: string;
  rateToBase: string;
  baseMinor: string;
  reference: string | null;
  cashAccountCode: string;
  transactionId: string | null;
}

export interface Bill {
  id: string;
  publicId: string;
  companyId: string;
  supplierId: string;
  supplierName: string;
  supplierEmail: string | null;
  number: string;
  reference: string | null;
  status: BillStatus;
  currency: string;
  baseCurrency: string;
  rateToBase: string;
  issuedAt: string | null;
  dueAt: string | null;
  subtotalMinor: string;
  taxMinor: string;
  totalMinor: string;
  baseTotalMinor: string;
  openingPaidMinor: string;
  paidMinor: string;
  outstandingMinor: string;
  conversion: boolean;
  notes: string | null;
  subject: Subject;
  transactionId: string | null;
  approvedAt: string | null;
  createdBy: string;
  createdAt: string;
  lines: BillLine[];
  payments: BillPayment[];
}

const APPROVE_REF = (billId: string) => `bill:${billId}`;
const PAYMENT_REF = (billId: string, ref: string) => `billpay:${billId}:${ref}`;

const RATE_SCALE = 10_000_000_000n;

function rateString(scaled: bigint): string {
  const whole = scaled / RATE_SCALE;
  const frac = (scaled % RATE_SCALE).toString().padStart(10, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
}

// ---------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------

export async function createSupplier(
  db: LedgerDb,
  companyId: string,
  input: { name: string; email?: string | null; externalRef?: string | null; defaultAccountCode?: string | null },
): Promise<Supplier> {
  const name = String(input.name ?? '').trim();
  if (name.length < 1 || name.length > 200) throw new LedgerError('supplier needs a name of 1 to 200 characters', 'invalid');
  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'suppliers')} (id, public_id, company_id, name, email, external_ref, default_account_code)
     VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7)`,
    [id, newId(), companyId, name, input.email?.trim() || null, input.externalRef?.trim() || null, input.defaultAccountCode?.trim() || null],
  );
  const s = await getSupplier(db, companyId, id);
  if (!s) throw new LedgerError('supplier was not written', 'invalid');
  return s;
}

export async function updateSupplier(db: LedgerDb, companyId: string, id: string, input: { name?: string; email?: string | null; defaultAccountCode?: string | null }): Promise<Supplier> {
  const s = await getSupplier(db, companyId, id);
  if (!s) throw new LedgerError(`supplier ${id} not found for company ${companyId}`, 'invalid');
  await db.sql.execute(
    `UPDATE ${table(db, 'suppliers')} SET name = COALESCE($3, name), email = CASE WHEN $4::boolean THEN $5 ELSE email END, default_account_code = CASE WHEN $6::boolean THEN $7 ELSE default_account_code END
      WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, input.name?.trim() || null, input.email !== undefined, input.email?.trim() || null, input.defaultAccountCode !== undefined, input.defaultAccountCode?.trim() || null],
  );
  return (await getSupplier(db, companyId, id)) ?? s;
}

interface SupplierRow { id: string; public_id: string; company_id: string; name: string; email: string | null; external_ref: string | null; default_account_code: string | null; created_at: string }

function supplierFromRow(r: SupplierRow): Supplier {
  return { id: r.id, publicId: r.public_id, companyId: r.company_id, name: r.name, email: r.email, externalRef: r.external_ref, defaultAccountCode: r.default_account_code, createdAt: r.created_at };
}

export async function getSupplier(db: LedgerDb, companyId: string, id: string): Promise<Supplier | null> {
  const rows = await db.sql.query<SupplierRow>(
    `SELECT id, public_id, company_id, name, email, external_ref, default_account_code, created_at::text AS created_at FROM ${table(db, 'suppliers')} WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id],
  );
  return rows[0] ? supplierFromRow(rows[0]) : null;
}

export async function listSuppliers(db: LedgerDb, companyId: string): Promise<Supplier[]> {
  const rows = await db.sql.query<SupplierRow>(
    `SELECT id, public_id, company_id, name, email, external_ref, default_account_code, created_at::text AS created_at FROM ${table(db, 'suppliers')} WHERE company_id = $1 ORDER BY name, created_at`,
    [companyId],
  );
  return rows.map(supplierFromRow);
}

/** Find by id, else by name (case-insensitive); create when `create` is set and nothing matches. */
export async function resolveSupplier(db: LedgerDb, companyId: string, ref: string, opts: { create?: boolean; email?: string | null } = {}): Promise<Supplier | null> {
  const needle = String(ref ?? '').trim();
  if (!needle) return null;
  if (/^[0-9a-f-]{36}$/i.test(needle)) {
    const byId = await getSupplier(db, companyId, needle);
    if (byId) return byId;
  }
  const all = await listSuppliers(db, companyId);
  const hit = all.find((s) => s.name.toLowerCase() === needle.toLowerCase());
  if (hit) return hit;
  if (!opts.create) return null;
  return createSupplier(db, companyId, { name: needle, email: opts.email ?? null });
}

// ---------------------------------------------------------------------------
// Bills
// ---------------------------------------------------------------------------

export interface CreateBillInput {
  supplierId: string;
  currency?: string | null;
  rateToBase?: string | number | null;
  lines: BillLineInput[];
  issuedAt?: Date | string | null;
  dueAt?: Date | string | null;
  /** The supplier's own invoice number. */
  reference?: string | null;
  notes?: string | null;
  subject?: Subject;
  createdBy?: string;
  /** Force a number (imports). Must be unique per company. */
  number?: string | null;
  /** Imports: what had already been paid in the previous system. */
  openingPaidMinor?: Minor | number | string | null;
  conversion?: boolean;
}

function normaliseLines(lines: BillLineInput[], defaultAccount: string): Array<{ position: number; description: string; quantity: string; unit: string; amount: string; tax: string; account: string }> {
  if (!Array.isArray(lines) || lines.length === 0) throw new LedgerError('a bill needs at least one line', 'invalid');
  if (lines.length > 200) throw new LedgerError('a bill may have at most 200 lines', 'invalid');
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
    const account = String(l.accountCode ?? '').trim() || defaultAccount;
    return { position: i + 1, description, quantity: (qty4 / 10_000).toFixed(4), unit: fromMinor(unit), amount: fromMinor(amount), tax: fromMinor(tax), account };
  });
}

async function assertAccounts(db: LedgerDb, companyId: string, codes: string[]): Promise<void> {
  const unique = [...new Set(codes)];
  const rows = await db.sql.query<{ code: string }>(`SELECT code FROM ${table(db, 'accounts')} WHERE company_id = $1 AND code = ANY(string_to_array($2::text, ','))`, [companyId, unique.join(',')]);
  const found = new Set(rows.map((r) => r.code));
  const missing = unique.filter((c) => !found.has(c));
  if (missing.length) throw new LedgerError(`unknown account code${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`, 'unknown_account');
}

async function nextBillNumber(db: LedgerDb, companyId: string): Promise<string> {
  const rows = await db.sql.query<{ n: unknown }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '^BILL-', ''), '')::int), 0) + 1 AS n FROM ${table(db, 'bills')} WHERE company_id = $1 AND number ~ '^BILL-[0-9]+$'`,
    [companyId],
  );
  return `BILL-${String(Number(rows[0]?.n ?? 1)).padStart(4, '0')}`;
}

async function writeLines(db: LedgerDb, billId: string, lines: ReturnType<typeof normaliseLines>): Promise<void> {
  const written = await db.sql.execute(
    `INSERT INTO ${table(db, 'bill_lines')} (id, bill_id, position, description, quantity, unit_amount_minor, amount_minor, tax_minor, account_code)
     SELECT gen_random_uuid(), $1::uuid, l.position, l.description, l.quantity, l.unit, l.amount, l.tax, l.account
       FROM jsonb_to_recordset($2::jsonb) AS l(position int, description text, quantity numeric, unit bigint, amount bigint, tax bigint, account text)`,
    [billId, JSON.stringify(lines)],
  );
  if (written.rowCount !== lines.length) throw new LedgerError('bill lines were not written', 'invalid');
}

/** Create a draft bill. Nothing posts until it is approved. */
export async function createBill(db: LedgerDb, companyId: string, input: CreateBillInput): Promise<Bill> {
  const settings = await getSettings(db, companyId);
  const base = settings.baseCurrency;
  const currency = assertCurrency(input.currency || base);
  let rate = RATE_SCALE;
  if (currency !== base) {
    if (input.rateToBase === undefined || input.rateToBase === null || input.rateToBase === '') throw new LedgerError(`a bill in ${currency} needs an exchange rate to ${base}`, 'invalid');
    rate = parseRate(input.rateToBase);
  }
  const supplier = await getSupplier(db, companyId, input.supplierId);
  if (!supplier) throw new LedgerError(`supplier ${input.supplierId} not found for company ${companyId}`, 'invalid');
  const lines = normaliseLines(input.lines, supplier.defaultAccountCode ?? ACCOUNT.OTHER_OPERATING);
  await assertAccounts(db, companyId, lines.map((l) => l.account));
  const subtotal = lines.reduce((s, l) => s + BigInt(l.amount), 0n);
  const tax = lines.reduce((s, l) => s + BigInt(l.tax), 0n);
  const total = subtotal + tax;
  const openingPaid = input.openingPaidMinor === undefined || input.openingPaidMinor === null || input.openingPaidMinor === '' ? 0n : toMinor(input.openingPaidMinor);
  if (openingPaid < 0n || openingPaid > total) throw new LedgerError('opening paid amount must be between zero and the total', 'invalid');
  const id = newId();
  const s = input.subject ?? {};
  const forced = input.number?.trim() || null;
  let number = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    number = forced ?? (await nextBillNumber(db, companyId));
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'bills')}
         (id, public_id, company_id, supplier_id, number, reference, status, currency, base_currency, rate_to_base, issued_at, due_at, subtotal_minor, tax_minor, total_minor, base_total_minor, opening_paid_minor, conversion, notes,
          subject_work_ref, subject_goal_ref, subject_agent_ref, subject_project_ref, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4::uuid, $5, $6, 'draft', $7, $8, $9::numeric, $10::timestamptz, $11::timestamptz, $12::bigint, $13::bigint, $14::bigint, $15::bigint, $16::bigint, $17::boolean, $18, $19, $20, $21, $22, $23)
       ON CONFLICT (company_id, number) DO NOTHING`,
      [id, newId(), companyId, supplier.id, number, input.reference?.trim().slice(0, 100) || null, currency, base, rateString(rate), input.issuedAt ? toIso(input.issuedAt) : null, input.dueAt ? toIso(input.dueAt) : null,
        fromMinor(subtotal), fromMinor(tax), fromMinor(total), fromMinor(toBase(total, rate)), fromMinor(openingPaid), input.conversion === true, input.notes?.trim().slice(0, 2000) || null,
        s.work ?? null, s.goal ?? null, s.agent ?? null, s.project ?? null, input.createdBy ?? 'board'],
    );
    if (r.rowCount === 1) break;
    if (forced) throw new LedgerError(`a bill numbered ${forced} already exists`, 'invalid');
    number = '';
  }
  if (!number) throw new LedgerError('could not allocate a bill number', 'invalid');
  try {
    await writeLines(db, id, lines);
  } catch (err) {
    await db.sql.execute(`DELETE FROM ${table(db, 'bill_lines')} WHERE bill_id = $1::uuid`, [id]);
    await db.sql.execute(`DELETE FROM ${table(db, 'bills')} WHERE id = $1::uuid AND status = 'draft'`, [id]);
    throw err;
  }
  const bill = await getBill(db, companyId, id);
  if (!bill) throw new LedgerError('bill was not written', 'invalid');
  return bill;
}

/** Change a draft: supplier, dates, reference, notes, lines. */
export async function updateBill(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { supplierId?: string; issuedAt?: Date | string | null; dueAt?: Date | string | null; reference?: string | null; notes?: string | null; lines?: BillLineInput[]; rateToBase?: string | number | null; currency?: string | null },
): Promise<Bill> {
  const bill = await getBill(db, companyId, id);
  if (!bill) throw new LedgerError(`bill ${id} not found for company ${companyId}`, 'invalid');
  if (bill.status !== 'draft') throw new LedgerError(`${bill.number} is ${bill.status}; only a draft can be edited`, 'invalid');
  let supplier = await getSupplier(db, companyId, input.supplierId ?? bill.supplierId);
  if (!supplier) throw new LedgerError('supplier not found', 'invalid');
  const currency = assertCurrency(input.currency || bill.currency);
  let rate = parseRate(bill.rateToBase);
  if (currency !== bill.baseCurrency && input.rateToBase !== undefined && input.rateToBase !== null && input.rateToBase !== '') rate = parseRate(input.rateToBase);
  if (currency === bill.baseCurrency) rate = RATE_SCALE;
  let subtotal = toMinor(bill.subtotalMinor);
  let tax = toMinor(bill.taxMinor);
  if (input.lines) {
    const lines = normaliseLines(input.lines, supplier.defaultAccountCode ?? ACCOUNT.OTHER_OPERATING);
    await assertAccounts(db, companyId, lines.map((l) => l.account));
    await db.sql.execute(`DELETE FROM ${table(db, 'bill_lines')} WHERE bill_id = $1::uuid`, [id]);
    await writeLines(db, id, lines);
    subtotal = lines.reduce((s, l) => s + BigInt(l.amount), 0n);
    tax = lines.reduce((s, l) => s + BigInt(l.tax), 0n);
  }
  const total = subtotal + tax;
  await db.sql.execute(
    `UPDATE ${table(db, 'bills')}
        SET supplier_id = $3::uuid, currency = $4, rate_to_base = $5::numeric,
            issued_at = CASE WHEN $6::boolean THEN $7::timestamptz ELSE issued_at END,
            due_at = CASE WHEN $8::boolean THEN $9::timestamptz ELSE due_at END,
            reference = CASE WHEN $10::boolean THEN $11 ELSE reference END,
            notes = CASE WHEN $12::boolean THEN $13 ELSE notes END,
            subtotal_minor = $14::bigint, tax_minor = $15::bigint, total_minor = $16::bigint, base_total_minor = $17::bigint
      WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`,
    [companyId, id, supplier.id, currency, rateString(rate), input.issuedAt !== undefined, input.issuedAt ? toIso(input.issuedAt) : null, input.dueAt !== undefined, input.dueAt ? toIso(input.dueAt) : null,
      input.reference !== undefined, input.reference?.trim().slice(0, 100) || null, input.notes !== undefined, input.notes?.trim().slice(0, 2000) || null,
      fromMinor(subtotal), fromMinor(tax), fromMinor(total), fromMinor(toBase(total, rate))],
  );
  return (await getBill(db, companyId, id)) ?? bill;
}

interface BillRow {
  id: string; public_id: string; company_id: string; supplier_id: string; supplier_name: string; supplier_email: string | null; number: string; reference: string | null; status: BillStatus;
  currency: string; base_currency: string; rate_to_base: string; issued_at: string | null; due_at: string | null; subtotal_minor: unknown; tax_minor: unknown; total_minor: unknown; base_total_minor: unknown;
  opening_paid_minor: unknown; conversion: boolean; notes: string | null; subject_work_ref: string | null; subject_goal_ref: string | null; subject_agent_ref: string | null; subject_project_ref: string | null;
  transaction_id: string | null; approved_at: string | null; created_by: string; created_at: string; paid_minor: unknown;
}

const SELECT = (db: LedgerDb) => `
  SELECT b.id, b.public_id, b.company_id, b.supplier_id, s.name AS supplier_name, s.email AS supplier_email, b.number, b.reference, b.status, b.currency, b.base_currency, b.rate_to_base::text AS rate_to_base,
         b.issued_at::text AS issued_at, b.due_at::text AS due_at, b.subtotal_minor, b.tax_minor, b.total_minor, b.base_total_minor, b.opening_paid_minor, b.conversion, b.notes,
         b.subject_work_ref, b.subject_goal_ref, b.subject_agent_ref, b.subject_project_ref, b.transaction_id, b.approved_at::text AS approved_at, b.created_by, b.created_at::text AS created_at,
         COALESCE((SELECT SUM(p.amount_minor) FROM ${table(db, 'bill_payments')} p WHERE p.bill_id = b.id AND p.transaction_id IS NOT NULL), 0) AS paid_minor
    FROM ${table(db, 'bills')} b JOIN ${table(db, 'suppliers')} s ON s.id = b.supplier_id`;

function fromRow(r: BillRow, lines: BillLine[], payments: BillPayment[]): Bill {
  const total = toMinor(r.total_minor);
  const paid = toMinor(r.paid_minor);
  const opening = toMinor(r.opening_paid_minor);
  const outstanding = r.status === 'draft' || r.status === 'void' ? 0n : total - opening - paid;
  return {
    id: r.id, publicId: r.public_id, companyId: r.company_id, supplierId: r.supplier_id, supplierName: r.supplier_name, supplierEmail: r.supplier_email, number: r.number, reference: r.reference, status: r.status,
    currency: r.currency, baseCurrency: r.base_currency, rateToBase: rateString(parseRate(r.rate_to_base ?? '1')), issuedAt: r.issued_at, dueAt: r.due_at,
    subtotalMinor: fromMinor(toMinor(r.subtotal_minor)), taxMinor: fromMinor(toMinor(r.tax_minor)), totalMinor: fromMinor(total), baseTotalMinor: fromMinor(toMinor(r.base_total_minor)),
    openingPaidMinor: fromMinor(opening), paidMinor: fromMinor(paid), outstandingMinor: fromMinor(outstanding < 0n ? 0n : outstanding), conversion: r.conversion === true, notes: r.notes,
    subject: {
      ...(r.subject_agent_ref ? { agent: r.subject_agent_ref } : {}),
      ...(r.subject_project_ref ? { project: r.subject_project_ref } : {}),
      ...(r.subject_goal_ref ? { goal: r.subject_goal_ref } : {}),
      ...(r.subject_work_ref ? { work: r.subject_work_ref } : {}),
    },
    transactionId: r.transaction_id, approvedAt: r.approved_at, createdBy: r.created_by, createdAt: r.created_at, lines, payments,
  };
}

async function linesAndPayments(db: LedgerDb, companyId: string, billIds: string[]): Promise<{ lines: Map<string, BillLine[]>; payments: Map<string, BillPayment[]> }> {
  const lines = new Map<string, BillLine[]>();
  const payments = new Map<string, BillPayment[]>();
  if (billIds.length === 0) return { lines, payments };
  const ids = billIds.join(',');
  const lr = await db.sql.query<{ bill_id: string; position: number; description: string; quantity: string; unit_amount_minor: unknown; amount_minor: unknown; tax_minor: unknown; account_code: string; name: string | null }>(
    `SELECT l.bill_id, l.position, l.description, l.quantity::text AS quantity, l.unit_amount_minor, l.amount_minor, l.tax_minor, l.account_code, a.name
       FROM ${table(db, 'bill_lines')} l LEFT JOIN ${table(db, 'accounts')} a ON a.company_id = $1 AND a.code = l.account_code
      WHERE l.bill_id = ANY(string_to_array($2::text, ',')::uuid[]) ORDER BY l.bill_id, l.position`,
    [companyId, ids],
  );
  for (const l of lr) {
    const list = lines.get(l.bill_id) ?? [];
    list.push({ position: Number(l.position), description: l.description, quantity: String(l.quantity), unitAmountMinor: fromMinor(toMinor(l.unit_amount_minor)), amountMinor: fromMinor(toMinor(l.amount_minor)), taxMinor: fromMinor(toMinor(l.tax_minor)), accountCode: l.account_code, accountName: l.name ?? '' });
    lines.set(l.bill_id, list);
  }
  const pr = await db.sql.query<{ bill_id: string; id: string; occurred_at: string; amount_minor: unknown; rate_to_base: string; base_minor: unknown; reference: string | null; cash_account_code: string; transaction_id: string | null }>(
    `SELECT bill_id, id, occurred_at::text AS occurred_at, amount_minor, rate_to_base::text AS rate_to_base, base_minor, reference, cash_account_code, transaction_id
       FROM ${table(db, 'bill_payments')} WHERE bill_id = ANY(string_to_array($1::text, ',')::uuid[]) AND transaction_id IS NOT NULL ORDER BY occurred_at`,
    [ids],
  );
  for (const p of pr) {
    const list = payments.get(p.bill_id) ?? [];
    list.push({ id: p.id, occurredAt: p.occurred_at, amountMinor: fromMinor(toMinor(p.amount_minor)), rateToBase: p.rate_to_base, baseMinor: fromMinor(toMinor(p.base_minor)), reference: p.reference, cashAccountCode: p.cash_account_code, transactionId: p.transaction_id });
    payments.set(p.bill_id, list);
  }
  return { lines, payments };
}

export async function getBill(db: LedgerDb, companyId: string, id: string): Promise<Bill | null> {
  const rows = await db.sql.query<BillRow>(`${SELECT(db)} WHERE b.company_id = $1 AND b.id = $2::uuid`, [companyId, id]);
  const r = rows[0];
  if (!r) return null;
  const { lines, payments } = await linesAndPayments(db, companyId, [id]);
  return fromRow(r, lines.get(id) ?? [], payments.get(id) ?? []);
}

export async function findBillByNumber(db: LedgerDb, companyId: string, number: string): Promise<Bill | null> {
  const rows = await db.sql.query<BillRow>(`${SELECT(db)} WHERE b.company_id = $1 AND upper(b.number) = upper($2)`, [companyId, number.trim()]);
  const r = rows[0];
  if (!r) return null;
  return getBill(db, companyId, r.id);
}

export async function listBills(db: LedgerDb, companyId: string, opts: { status?: BillStatus; supplierId?: string; limit?: number; withLines?: boolean } = {}): Promise<Bill[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 1000);
  const rows = await db.sql.query<BillRow>(
    `${SELECT(db)} WHERE b.company_id = $1 AND ($2::text IS NULL OR b.status = $2::text) AND ($3::uuid IS NULL OR b.supplier_id = $3::uuid) ORDER BY COALESCE(b.issued_at, b.created_at) DESC, b.created_at DESC LIMIT $4::int`,
    [companyId, opts.status ?? null, opts.supplierId ?? null, limit],
  );
  if (!opts.withLines) return rows.map((r) => fromRow(r, [], []));
  const { lines, payments } = await linesAndPayments(db, companyId, rows.map((r) => r.id));
  return rows.map((r) => fromRow(r, lines.get(r.id) ?? [], payments.get(r.id) ?? []));
}

async function setStatus(db: LedgerDb, companyId: string, id: string, from: BillStatus[], to: BillStatus, extra: { approvedAt?: string | null; transactionId?: string | null } = {}): Promise<void> {
  await db.sql.execute(
    `UPDATE ${table(db, 'bills')} SET status = $3, approved_at = COALESCE($4::timestamptz, approved_at), transaction_id = COALESCE($5::uuid, transaction_id)
      WHERE company_id = $1 AND id = $2::uuid AND status = ANY(string_to_array($6::text, ','))`,
    [companyId, id, to, extra.approvedAt ?? null, extra.transactionId ?? null, from.join(',')],
  );
}

/**
 * Approve a draft: the expense is recognised and the payable booked, dated the
 * bill date (or now). A conversion bill is approved without posting. Idempotent.
 */
export async function approveBill(db: LedgerDb, companyId: string, id: string, opts: { approvedAt?: Date | string; createdBy?: string } = {}): Promise<Bill> {
  const bill = await getBill(db, companyId, id);
  if (!bill) throw new LedgerError(`bill ${id} not found for company ${companyId}`, 'invalid');
  if (bill.status !== 'draft') {
    if (bill.status === 'void') throw new LedgerError(`bill ${bill.number} is void`, 'invalid');
    return bill;
  }
  const rate = parseRate(bill.rateToBase);
  const baseTotal = toMinor(bill.baseTotalMinor);
  if (baseTotal <= 0n) throw new LedgerError(`bill ${bill.number} has no amount`, 'invalid');
  const at = toIso(opts.approvedAt ?? bill.issuedAt ?? new Date());
  if (!bill.issuedAt) await db.sql.execute(`UPDATE ${table(db, 'bills')} SET issued_at = $3::timestamptz WHERE company_id = $1 AND id = $2::uuid`, [companyId, id, at]);
  let transactionId: string | null = null;
  if (!bill.conversion) {
    // One debit per account, tax to 2100, the last line takes the rounding so base debits equal the base credit.
    const byAccount = new Map<string, Minor>();
    for (const l of bill.lines) byAccount.set(l.accountCode, (byAccount.get(l.accountCode) ?? 0n) + toMinor(l.amountMinor));
    const taxBase = toBase(toMinor(bill.taxMinor), rate);
    const entries: EntryInput[] = [];
    let debited = 0n;
    const codes = [...byAccount.keys()];
    codes.forEach((code, i) => {
      const last = i === codes.length - 1;
      const amount = last ? baseTotal - taxBase - debited : toBase(byAccount.get(code)!, rate);
      debited += amount;
      if (amount > 0n) entries.push({ accountCode: code, direction: 'debit', amountMinor: amount, subject: bill.subject });
    });
    if (taxBase > 0n) entries.push({ accountCode: ACCOUNT.TAX_PAYABLE, direction: 'debit', amountMinor: taxBase, subject: bill.subject });
    entries.push({ accountCode: ACCOUNT.PAYABLES, direction: 'credit', amountMinor: baseTotal, subject: bill.subject });
    const fx = bill.currency !== bill.baseCurrency ? ` (${bill.currency} ${fromMinor(toMinor(bill.totalMinor))} at ${bill.rateToBase})` : '';
    const r = await postTransaction(db, {
      companyId,
      occurredAt: at,
      description: `Bill ${bill.number} · ${bill.supplierName}${bill.reference ? ` · ${bill.reference}` : ''}${fx}`,
      sourcePlatform: 'manual',
      sourceKind: 'bill',
      sourceRef: APPROVE_REF(bill.id),
      currency: bill.baseCurrency,
      createdBy: opts.createdBy ?? 'board',
      entries,
    });
    transactionId = r.transactionId;
  }
  const after0 = await getBill(db, companyId, id);
  const outstanding = after0 ? toMinor(after0.totalMinor) - toMinor(after0.openingPaidMinor) : baseTotal;
  await setStatus(db, companyId, id, ['draft'], outstanding === 0n ? 'paid' : toMinor(bill.openingPaidMinor) > 0n ? 'part_paid' : 'approved', { approvedAt: at, transactionId });
  const after = await getBill(db, companyId, id);
  if (!after) throw new LedgerError('bill vanished while approving', 'invalid');
  return after;
}

/** Pay some or all of an approved bill from a cash account (Treasury or a bank sub-account). */
export async function payBill(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { amountMinor?: Minor | number | string | null; occurredAt?: Date | string; reference?: string | null; createdBy?: string; cashAccountCode?: string | null; rateToBase?: string | number | null },
): Promise<Bill> {
  const bill = await getBill(db, companyId, id);
  if (!bill) throw new LedgerError(`bill ${id} not found for company ${companyId}`, 'invalid');
  if (bill.status !== 'approved' && bill.status !== 'part_paid') throw new LedgerError(`bill ${bill.number} is ${bill.status}; only an approved bill can be paid`, 'invalid');
  const outstanding = toMinor(bill.outstandingMinor);
  const amount = input.amountMinor === undefined || input.amountMinor === null || input.amountMinor === '' ? outstanding : assertPositiveMinor(input.amountMinor, 'payment amount');
  if (amount > outstanding) throw new LedgerError(`payment ${fromMinor(amount)} exceeds the ${fromMinor(outstanding)} outstanding on ${bill.number}`, 'invalid');
  const issueRate = parseRate(bill.rateToBase);
  const payRate = input.rateToBase === undefined || input.rateToBase === null || input.rateToBase === '' ? issueRate : parseRate(input.rateToBase);
  const cashBase = toBase(amount, payRate);
  const owedBase = toBase(toMinor(bill.totalMinor) - toMinor(bill.openingPaidMinor), issueRate);
  const remainingBase = owedBase - bill.payments.reduce((s, p) => s + toBase(toMinor(p.amountMinor), issueRate), 0n);
  const reliefBase = amount === outstanding ? remainingBase : toBase(amount, issueRate);
  const diff = reliefBase - cashBase; // positive: paid less base than owed, a gain
  const ref = (input.reference ?? '').trim() || newId();
  const occurredAt = toIso(input.occurredAt ?? new Date());
  const cash = input.cashAccountCode?.trim() || ACCOUNT.TREASURY;
  await assertAccounts(db, companyId, [cash]);
  const paymentId = newId();
  const inserted = await db.sql.execute(
    `INSERT INTO ${table(db, 'bill_payments')} (id, company_id, bill_id, occurred_at, amount_minor, rate_to_base, base_minor, reference, cash_account_code)
     VALUES ($1::uuid, $2, $3::uuid, $4::timestamptz, $5::bigint, $6::numeric, $7::bigint, $8, $9)
     ON CONFLICT (bill_id, reference) DO NOTHING`,
    [paymentId, companyId, bill.id, occurredAt, fromMinor(amount), rateString(payRate), fromMinor(cashBase), ref, cash],
  );
  if (inserted.rowCount === 0) return bill;
  const entries: EntryInput[] = [
    { accountCode: ACCOUNT.PAYABLES, direction: 'debit', amountMinor: reliefBase, subject: bill.subject },
    { accountCode: cash, direction: 'credit', amountMinor: cashBase, subject: bill.subject },
  ];
  if (diff > 0n) entries.push({ accountCode: ACCOUNT.CURRENCY_GAINS, direction: 'credit', amountMinor: diff, subject: bill.subject });
  if (diff < 0n) entries.push({ accountCode: ACCOUNT.CURRENCY_GAINS, direction: 'debit', amountMinor: -diff, subject: bill.subject });
  const fx = bill.currency !== bill.baseCurrency ? ` (${bill.currency} ${fromMinor(amount)} at ${rateString(payRate)})` : '';
  const r = await postTransaction(db, {
    companyId,
    occurredAt,
    description: `Payment of ${bill.number} · ${bill.supplierName}${fx}`,
    sourcePlatform: 'manual',
    sourceKind: 'payment',
    sourceRef: PAYMENT_REF(bill.id, ref),
    currency: bill.baseCurrency,
    createdBy: input.createdBy ?? 'board',
    entries,
  });
  await db.sql.execute(`UPDATE ${table(db, 'bill_payments')} SET transaction_id = $2::uuid WHERE id = $1::uuid`, [paymentId, r.transactionId]);
  const after = await getBill(db, companyId, id);
  if (!after) throw new LedgerError('bill vanished while paying', 'invalid');
  await setStatus(db, companyId, id, ['approved', 'part_paid'], toMinor(after.outstandingMinor) === 0n ? 'paid' : 'part_paid');
  return (await getBill(db, companyId, id)) ?? after;
}

/** Cancel a bill. A draft is voided; an approved bill with nothing paid is reversed. */
export async function voidBill(db: LedgerDb, companyId: string, id: string, opts: { createdBy?: string; reason?: string } = {}): Promise<Bill> {
  const bill = await getBill(db, companyId, id);
  if (!bill) throw new LedgerError(`bill ${id} not found for company ${companyId}`, 'invalid');
  if (bill.status === 'void') return bill;
  if (bill.status === 'draft') {
    await setStatus(db, companyId, id, ['draft'], 'void');
    return (await getBill(db, companyId, id)) ?? bill;
  }
  if (toMinor(bill.paidMinor) !== 0n) throw new LedgerError(`${bill.number} has payments on it and cannot be voided`, 'invalid');
  const tx = await findTransactionBySourceRef(db, companyId, 'manual', APPROVE_REF(bill.id));
  if (tx) await postReversal(db, companyId, tx, { description: `Void ${bill.number}${opts.reason ? ` · ${opts.reason}` : ''}`, createdBy: opts.createdBy ?? 'board' });
  await setStatus(db, companyId, id, ['approved', 'part_paid'], 'void');
  return (await getBill(db, companyId, id)) ?? bill;
}

/** Delete a draft outright. */
export async function deleteBill(db: LedgerDb, companyId: string, id: string): Promise<{ deleted: boolean }> {
  const bill = await getBill(db, companyId, id);
  if (!bill) throw new LedgerError(`bill ${id} not found for company ${companyId}`, 'invalid');
  if (bill.status !== 'draft') throw new LedgerError(`${bill.number} is ${bill.status}; void it instead`, 'invalid');
  await db.sql.execute(`DELETE FROM ${table(db, 'bill_lines')} WHERE bill_id = $1::uuid`, [id]);
  const r = await db.sql.execute(`DELETE FROM ${table(db, 'bills')} WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`, [companyId, id]);
  return { deleted: r.rowCount === 1 };
}

/** What is still owed to suppliers, in base currency at the bill rates. */
export async function payablesOutstanding(db: LedgerDb, companyId: string): Promise<Minor> {
  const open = (await listBills(db, companyId, { limit: 1000 })).filter((b) => b.status === 'approved' || b.status === 'part_paid');
  return open.reduce((acc, b) => acc + toBase(toMinor(b.outstandingMinor), parseRate(b.rateToBase)), 0n);
}
