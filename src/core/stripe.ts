/**
 * The company's Stripe link: the rows only. Which connected account it is,
 * which bank account its balance feeds, which payment option prints on
 * invoices, and where the feed cursor stands. Talking to Stripe (through
 * ai3.co) lives in the plugin layer.
 */
import { LedgerError } from './ledger.js';
import { table, type LedgerDb } from './sql.js';

export interface StripeLink {
  companyId: string;
  accountId: string | null;
  bankAccountId: string | null;
  paymentMethodId: string | null;
  /** The bank account the company's own saved card is booked against when it pays others. */
  cardBankAccountId: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
  feedCursorUnix: number;
  lastSyncedAt: string | null;
  createdAt: string;
}

interface Row { company_id: string; account_id: string | null; bank_account_id: string | null; payment_method_id: string | null; card_bank_account_id: string | null; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean; feed_cursor_unix: string; last_synced_at: string | null; created_at: string }

function fromRow(r: Row): StripeLink {
  return { companyId: r.company_id, accountId: r.account_id, bankAccountId: r.bank_account_id, paymentMethodId: r.payment_method_id, cardBankAccountId: r.card_bank_account_id, chargesEnabled: r.charges_enabled === true, payoutsEnabled: r.payouts_enabled === true, detailsSubmitted: r.details_submitted === true, feedCursorUnix: Number(r.feed_cursor_unix), lastSyncedAt: r.last_synced_at, createdAt: r.created_at };
}

const SELECT = (db: LedgerDb) => `SELECT company_id, account_id, bank_account_id, payment_method_id, card_bank_account_id, charges_enabled, payouts_enabled, details_submitted, feed_cursor_unix::text AS feed_cursor_unix, last_synced_at::text AS last_synced_at, created_at::text AS created_at FROM ${table(db, 'company_stripe')}`;

export async function getStripeLink(db: LedgerDb, companyId: string): Promise<StripeLink | null> {
  const rows = await db.sql.query<Row>(`${SELECT(db)} WHERE company_id = $1`, [companyId]);
  return rows[0] ? fromRow(rows[0]) : null;
}

/** Upsert; only the fields given change. */
export async function saveStripeLink(db: LedgerDb, companyId: string, patch: Partial<Omit<StripeLink, 'companyId' | 'createdAt'>>): Promise<StripeLink> {
  const cur = (await getStripeLink(db, companyId)) ?? { companyId, accountId: null, bankAccountId: null, paymentMethodId: null, cardBankAccountId: null, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false, feedCursorUnix: 0, lastSyncedAt: null, createdAt: '' };
  const next = { ...cur, ...patch };
  await db.sql.execute(
    `INSERT INTO ${table(db, 'company_stripe')} (company_id, account_id, bank_account_id, payment_method_id, card_bank_account_id, charges_enabled, payouts_enabled, details_submitted, feed_cursor_unix, last_synced_at)
     VALUES ($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::boolean, $7::boolean, $8::boolean, $9::bigint, $10::timestamptz)
     ON CONFLICT (company_id) DO UPDATE SET account_id = EXCLUDED.account_id, bank_account_id = EXCLUDED.bank_account_id, payment_method_id = EXCLUDED.payment_method_id, card_bank_account_id = EXCLUDED.card_bank_account_id,
       charges_enabled = EXCLUDED.charges_enabled, payouts_enabled = EXCLUDED.payouts_enabled, details_submitted = EXCLUDED.details_submitted, feed_cursor_unix = EXCLUDED.feed_cursor_unix, last_synced_at = EXCLUDED.last_synced_at, updated_at = now()`,
    [companyId, next.accountId, next.bankAccountId, next.paymentMethodId, next.cardBankAccountId, next.chargesEnabled, next.payoutsEnabled, next.detailsSubmitted, String(Math.max(0, Math.floor(next.feedCursorUnix))), next.lastSyncedAt],
  );
  const saved = await getStripeLink(db, companyId);
  if (!saved) throw new LedgerError('stripe link was not written', 'invalid');
  return saved;
}
