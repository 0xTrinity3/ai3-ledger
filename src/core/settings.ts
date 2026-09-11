/**
 * Company settings and payment options.
 *
 * Settings: the base currency the books are kept in and what goes at the top
 * of an invoice. Payment options: the ways the company accepts money (a bank
 * account, a Stripe link, a crypto wallet, anything else), chosen per invoice
 * and printed on it as "How to pay".
 */
import { LedgerError } from './ledger.js';
import { assertCurrency, newId, table, type LedgerDb } from './sql.js';

export interface CompanySettings {
  companyId: string;
  baseCurrency: string;
  legalName: string | null;
  address: string | null;
  email: string | null;
  taxId: string | null;
  invoiceFooter: string | null;
  replyTo: string | null;
  /** ai3.co connection: the per-company key and the origin to push to. */
  ai3Key: string | null;
  ai3Origin: string | null;
  /** Send overdue reminders from the owner's mailbox at 3, 14 and 30 days. Off unless a person turns it on. */
  remindersEnabled: boolean;
}

export async function getSettings(db: LedgerDb, companyId: string, fallbackCurrency = 'USD'): Promise<CompanySettings> {
  const rows = await db.sql.query<{ base_currency: string; legal_name: string | null; address: string | null; email: string | null; tax_id: string | null; invoice_footer: string | null; reply_to: string | null; ai3_key: string | null; ai3_origin: string | null; reminders_enabled: boolean }>(
    `SELECT base_currency, legal_name, address, email, tax_id, invoice_footer, reply_to, ai3_key, ai3_origin, reminders_enabled FROM ${table(db, 'company_settings')} WHERE company_id = $1`,
    [companyId],
  );
  const r = rows[0];
  if (!r) return { companyId, baseCurrency: fallbackCurrency, legalName: null, address: null, email: null, taxId: null, invoiceFooter: null, replyTo: null, ai3Key: null, ai3Origin: null, remindersEnabled: false };
  return { companyId, baseCurrency: r.base_currency, legalName: r.legal_name, address: r.address, email: r.email, taxId: r.tax_id, invoiceFooter: r.invoice_footer, replyTo: r.reply_to, ai3Key: r.ai3_key, ai3Origin: r.ai3_origin, remindersEnabled: r.reminders_enabled === true };
}

export async function updateSettings(db: LedgerDb, companyId: string, input: Partial<Omit<CompanySettings, 'companyId'>>): Promise<CompanySettings> {
  const current = await getSettings(db, companyId);
  const next = { ...current, ...input };
  const base = assertCurrency(next.baseCurrency);
  const clean = (v: string | null | undefined, max: number) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);
  await db.sql.execute(
    `INSERT INTO ${table(db, 'company_settings')} (company_id, base_currency, legal_name, address, email, tax_id, invoice_footer, reply_to, ai3_key, ai3_origin, reminders_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::boolean)
     ON CONFLICT (company_id) DO UPDATE SET base_currency = EXCLUDED.base_currency, legal_name = EXCLUDED.legal_name, address = EXCLUDED.address,
       email = EXCLUDED.email, tax_id = EXCLUDED.tax_id, invoice_footer = EXCLUDED.invoice_footer, reply_to = EXCLUDED.reply_to, ai3_key = EXCLUDED.ai3_key, ai3_origin = EXCLUDED.ai3_origin, reminders_enabled = EXCLUDED.reminders_enabled, updated_at = now()`,
    [companyId, base, clean(next.legalName, 200), clean(next.address, 500), clean(next.email, 200), clean(next.taxId, 100), clean(next.invoiceFooter, 1000), clean(next.replyTo, 200), clean(next.ai3Key, 200), clean(next.ai3Origin, 200), next.remindersEnabled === true],
  );
  return getSettings(db, companyId);
}

// ---------------------------------------------------------------------------
// Payment options
// ---------------------------------------------------------------------------

export type PaymentKind = 'bank' | 'stripe' | 'crypto' | 'other';

/** What each kind carries. Only strings; printed on the invoice as given. */
export interface PaymentDetails {
  // bank
  accountName?: string;
  bankName?: string;
  accountNumber?: string;
  iban?: string;
  sortCode?: string;
  routingNumber?: string;
  bic?: string;
  // stripe
  url?: string;
  // crypto
  network?: string; // e.g. Ethereum, Base, Solana, Bitcoin
  asset?: string; // e.g. USDC, ETH, BTC
  address?: string;
  // other
  instructions?: string;
}

export interface PaymentMethod {
  id: string;
  companyId: string;
  kind: PaymentKind;
  label: string;
  currency: string | null;
  details: PaymentDetails;
  isDefault: boolean;
  enabled: boolean;
  position: number;
}

const DETAIL_KEYS: Record<PaymentKind, Array<keyof PaymentDetails>> = {
  bank: ['accountName', 'bankName', 'accountNumber', 'iban', 'sortCode', 'routingNumber', 'bic'],
  stripe: ['url'],
  crypto: ['network', 'asset', 'address'],
  other: ['instructions'],
};

function cleanDetails(kind: PaymentKind, raw: unknown): PaymentDetails {
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out: PaymentDetails = {};
  for (const k of DETAIL_KEYS[kind]) {
    const v = src[k];
    if (typeof v === 'string' && v.trim()) out[k] = v.trim().slice(0, 500);
  }
  if (kind === 'crypto') {
    if (!out.address) throw new LedgerError('a crypto payment option needs a wallet address', 'invalid');
    if (!out.asset) throw new LedgerError('a crypto payment option needs the asset (USDC, ETH, BTC…)', 'invalid');
    if (!out.network) throw new LedgerError('a crypto payment option needs the network (Base, Ethereum, Solana…)', 'invalid');
  }
  if (kind === 'stripe' && !out.url) throw new LedgerError('a Stripe payment option needs a payment link', 'invalid');
  if (kind === 'stripe' && out.url && !/^https:\/\//i.test(out.url)) throw new LedgerError('the Stripe payment link must start with https://', 'invalid');
  if (kind === 'bank' && !out.accountNumber && !out.iban) throw new LedgerError('a bank payment option needs an account number or IBAN', 'invalid');
  if (kind === 'other' && !out.instructions) throw new LedgerError('say how to pay', 'invalid');
  return out;
}

interface MethodRow { id: string; company_id: string; kind: PaymentKind; label: string; currency: string | null; details: unknown; is_default: boolean; enabled: boolean; position: number }

function methodFromRow(r: MethodRow): PaymentMethod {
  let details: PaymentDetails = {};
  try { details = typeof r.details === 'string' ? (JSON.parse(r.details) as PaymentDetails) : ((r.details as PaymentDetails) ?? {}); } catch { details = {}; }
  return { id: r.id, companyId: r.company_id, kind: r.kind, label: r.label, currency: r.currency, details, isDefault: r.is_default, enabled: r.enabled, position: Number(r.position) };
}

const METHOD_SELECT = (db: LedgerDb) => `SELECT id, company_id, kind, label, currency, details, is_default, enabled, position FROM ${table(db, 'payment_methods')}`;

export async function listPaymentMethods(db: LedgerDb, companyId: string, opts: { enabledOnly?: boolean } = {}): Promise<PaymentMethod[]> {
  const rows = await db.sql.query<MethodRow>(
    `${METHOD_SELECT(db)} WHERE company_id = $1 AND ($2::boolean = false OR enabled = true) ORDER BY position, created_at`,
    [companyId, opts.enabledOnly === true],
  );
  return rows.map(methodFromRow);
}

export async function createPaymentMethod(
  db: LedgerDb,
  companyId: string,
  input: { kind: PaymentKind; label: string; currency?: string | null; details: unknown; isDefault?: boolean },
): Promise<PaymentMethod> {
  if (!['bank', 'stripe', 'crypto', 'other'].includes(input.kind)) throw new LedgerError('kind must be bank, stripe, crypto or other', 'invalid');
  const label = String(input.label ?? '').trim();
  if (!label) throw new LedgerError('a payment option needs a label', 'invalid');
  const details = cleanDetails(input.kind, input.details);
  const currency = input.currency ? assertCurrency(input.currency) : null;
  const existing = await listPaymentMethods(db, companyId);
  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'payment_methods')} (id, company_id, kind, label, currency, details, is_default, position)
     VALUES ($1::uuid, $2, $3, $4, $5, $6::jsonb, $7, $8::int)`,
    [id, companyId, input.kind, label.slice(0, 120), currency, JSON.stringify(details), input.isDefault ?? true, existing.length],
  );
  const rows = await db.sql.query<MethodRow>(`${METHOD_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  if (!rows[0]) throw new LedgerError('payment option was not written', 'invalid');
  return methodFromRow(rows[0]);
}

export async function updatePaymentMethod(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { label?: string; enabled?: boolean; isDefault?: boolean; details?: unknown; currency?: string | null },
): Promise<PaymentMethod> {
  const rows = await db.sql.query<MethodRow>(`${METHOD_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  const current = rows[0] ? methodFromRow(rows[0]) : null;
  if (!current) throw new LedgerError('payment option not found', 'invalid');
  const details = input.details !== undefined ? cleanDetails(current.kind, input.details) : current.details;
  const currency = input.currency === undefined ? current.currency : input.currency ? assertCurrency(input.currency) : null;
  await db.sql.execute(
    `UPDATE ${table(db, 'payment_methods')} SET label = $3, enabled = $4, is_default = $5, details = $6::jsonb, currency = $7, updated_at = now() WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, (input.label ?? current.label).trim().slice(0, 120) || current.label, input.enabled ?? current.enabled, input.isDefault ?? current.isDefault, JSON.stringify(details), currency],
  );
  const after = await db.sql.query<MethodRow>(`${METHOD_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return methodFromRow(after[0]!);
}

/** The snapshot printed on an invoice: label, kind and details at the moment of issue. */
export interface PaymentInstruction { id: string; kind: PaymentKind; label: string; currency: string | null; details: PaymentDetails }

export async function paymentInstructionsFor(db: LedgerDb, companyId: string, ids: string[] | null): Promise<PaymentInstruction[]> {
  const all = await listPaymentMethods(db, companyId, { enabledOnly: true });
  const chosen = ids === null ? all.filter((m) => m.isDefault) : all.filter((m) => ids.includes(m.id));
  return chosen.map((m) => ({ id: m.id, kind: m.kind, label: m.label, currency: m.currency, details: m.details }));
}
