/**
 * The double-entry core.
 *
 * Rules enforced here and again in the database:
 *  - every transaction sums to zero
 *  - the ledger is append-only; corrections are reversing transactions
 *  - amounts are positive bigint minor units; sign comes from direction
 *  - posting is atomic through a single `ledger_post(...)` call
 *  - a repeated (company, platform, kind, ref) is a no-op, not an error
 *
 * Nothing in this file knows about Paperclip.
 */
import { ACCOUNT, SEED_ACCOUNTS, normalSide, type AccountType } from './accounts.js';
import { assertCurrency, assertPositiveMinor, fromMinor, table, toMinor, type LedgerDb, type Minor } from './sql.js';

export class LedgerError extends Error {
  constructor(
    message: string,
    public readonly code:
      | 'unbalanced'
      | 'too_few_entries'
      | 'mixed_currency'
      | 'unknown_account'
      | 'period_closed'
      | 'invalid',
  ) {
    super(message);
    this.name = 'LedgerError';
  }
}

export type Direction = 'debit' | 'credit';
export type SourceKind = 'cost_sweep' | 'funding' | 'invoice' | 'payment' | 'manual' | 'reversal';

export interface Subject {
  agent?: string;
  project?: string;
  goal?: string;
  work?: string;
}

export interface EntryInput {
  accountCode: string;
  direction: Direction;
  amountMinor: Minor | number | string;
  subject?: Subject;
}

export interface PostInput {
  companyId: string;
  occurredAt: Date | string;
  description?: string;
  sourcePlatform: string;
  sourceKind: SourceKind;
  sourceRef?: string | null;
  currency: string;
  entries: EntryInput[];
  createdBy?: string;
  reversesId?: string | null;
}

export type PostResult =
  | { ok: true; transactionId: string; publicId: string; inserted: true }
  | { ok: true; transactionId: string; publicId: string; inserted: false };

/** Validate a posting before it goes anywhere near the database. Throws LedgerError. */
export function validatePost(input: PostInput): { currency: string; entries: EntryInput[] } {
  const currency = assertCurrency(input.currency);
  if (!Array.isArray(input.entries) || input.entries.length < 2) {
    throw new LedgerError('a transaction needs at least two entries', 'too_few_entries');
  }
  let debit = 0n;
  let credit = 0n;
  for (const e of input.entries) {
    if (e.direction !== 'debit' && e.direction !== 'credit') {
      throw new LedgerError(`entry direction must be debit or credit, got ${String(e.direction)}`, 'invalid');
    }
    if (typeof e.accountCode !== 'string' || e.accountCode.length === 0) {
      throw new LedgerError('entry needs an account code', 'invalid');
    }
    const amt = assertPositiveMinor(e.amountMinor, 'entry amount');
    if (e.direction === 'debit') debit += amt;
    else credit += amt;
  }
  if (debit !== credit) {
    throw new LedgerError(`transaction does not balance: debits ${debit} vs credits ${credit}`, 'unbalanced');
  }
  return { currency, entries: input.entries };
}

/** Idempotently create the chart of accounts for a company. Returns how many rows were added. */
export async function seedAccounts(db: LedgerDb, companyId: string, currency: string): Promise<number> {
  assertCurrency(currency);
  let added = 0;
  for (const a of SEED_ACCOUNTS) {
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'accounts')} (company_id, code, name, type, currency, is_system)
       VALUES ($1, $2, $3, $4, $5, true)
       ON CONFLICT (company_id, code) DO NOTHING`,
      [companyId, a.code, a.name, a.type, currency],
    );
    added += r.rowCount;
  }
  return added;
}

/** Post a balanced transaction atomically. A duplicate source ref returns the existing id with inserted=false. */
export async function postTransaction(db: LedgerDb, input: PostInput): Promise<PostResult> {
  const { currency, entries } = validatePost(input);
  const occurredAt = input.occurredAt instanceof Date ? input.occurredAt.toISOString() : input.occurredAt;
  const payload = entries.map((e) => ({
    code: e.accountCode,
    direction: e.direction,
    amount: fromMinor(assertPositiveMinor(e.amountMinor, 'entry amount')),
    agent: e.subject?.agent ?? null,
    project: e.subject?.project ?? null,
    goal: e.subject?.goal ?? null,
    work: e.subject?.work ?? null,
  }));

  let rows: Array<{ id: string; public_id: string; inserted: boolean }>;
  try {
    rows = await db.sql.query(
      `SELECT id, public_id, inserted FROM ${table(db, 'ledger_post')}($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::uuid, $9, $10::jsonb)`,
      [
        input.companyId,
        occurredAt,
        input.description ?? '',
        input.sourcePlatform,
        input.sourceKind,
        input.sourceRef ?? null,
        input.createdBy ?? 'system',
        input.reversesId ?? null,
        currency,
        JSON.stringify(payload),
      ],
    );
  } catch (err) {
    throw translateDbError(err);
  }
  const row = rows[0];
  if (!row) throw new LedgerError('ledger_post returned no row', 'invalid');
  return { ok: true, transactionId: row.id, publicId: row.public_id, inserted: row.inserted === true };
}

/** Post the exact mirror of an existing transaction. This is the only way to "undo" anything. */
export async function postReversal(
  db: LedgerDb,
  companyId: string,
  transactionId: string,
  opts: { occurredAt?: Date | string; description?: string; createdBy?: string } = {},
): Promise<PostResult> {
  const original = await db.sql.query<{
    company_id: string;
    currency: string;
    source_platform: string;
    description: string;
  }>(
    `SELECT t.company_id, t.source_platform, t.description, MIN(e.currency) AS currency
       FROM ${table(db, 'transactions')} t JOIN ${table(db, 'entries')} e ON e.transaction_id = t.id
      WHERE t.id = $1::uuid AND t.company_id = $2
      GROUP BY t.id`,
    [transactionId, companyId],
  );
  const t = original[0];
  if (!t) throw new LedgerError(`transaction ${transactionId} not found for company ${companyId}`, 'invalid');

  const lines = await db.sql.query<{
    code: string;
    direction: Direction;
    amount_minor: unknown;
    subject_agent_ref: string | null;
    subject_project_ref: string | null;
    subject_goal_ref: string | null;
    subject_work_ref: string | null;
  }>(
    `SELECT a.code, e.direction, e.amount_minor, e.subject_agent_ref, e.subject_project_ref, e.subject_goal_ref, e.subject_work_ref
       FROM ${table(db, 'entries')} e JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
      WHERE e.transaction_id = $1::uuid`,
    [transactionId],
  );

  return postTransaction(db, {
    companyId,
    occurredAt: opts.occurredAt ?? new Date(),
    description: opts.description ?? `Reversal of ${t.description || transactionId}`,
    sourcePlatform: t.source_platform,
    sourceKind: 'reversal',
    sourceRef: `reversal:${transactionId}`,
    currency: t.currency,
    createdBy: opts.createdBy ?? 'system',
    reversesId: transactionId,
    entries: lines.map((l) => ({
      accountCode: l.code,
      direction: l.direction === 'debit' ? 'credit' : 'debit',
      amountMinor: toMinor(l.amount_minor),
      subject: {
        ...(l.subject_agent_ref ? { agent: l.subject_agent_ref } : {}),
        ...(l.subject_project_ref ? { project: l.subject_project_ref } : {}),
        ...(l.subject_goal_ref ? { goal: l.subject_goal_ref } : {}),
        ...(l.subject_work_ref ? { work: l.subject_work_ref } : {}),
      },
    })),
  });
}

export interface AccountBalance {
  code: string;
  name: string;
  type: AccountType;
  currency: string;
  debitMinor: Minor;
  creditMinor: Minor;
  /** Signed on the account's normal side: positive means "the balance people expect". */
  balanceMinor: Minor;
}

/** Balances of every account for a company, optionally as of a moment (inclusive). */
export async function accountBalances(db: LedgerDb, companyId: string, asOf?: Date | string): Promise<AccountBalance[]> {
  const asOfIso = asOf instanceof Date ? asOf.toISOString() : asOf ?? null;
  const rows = await db.sql.query<{
    code: string;
    name: string;
    type: AccountType;
    currency: string;
    debit: unknown;
    credit: unknown;
  }>(
    `SELECT a.code, a.name, a.type, a.currency,
            COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_minor END), 0) AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor END), 0) AS credit
       FROM ${table(db, 'accounts')} a
       LEFT JOIN (
            SELECT e.account_id, e.direction, e.amount_minor
              FROM ${table(db, 'entries')} e
              JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
             WHERE $2::timestamptz IS NULL OR t.occurred_at <= $2::timestamptz
       ) e ON e.account_id = a.id
      WHERE a.company_id = $1
      GROUP BY a.id, a.code, a.name, a.type, a.currency
      ORDER BY a.code`,
    [companyId, asOfIso],
  );
  return rows.map((r) => {
    const debit = toMinor(r.debit);
    const credit = toMinor(r.credit);
    const balance = normalSide(r.type) === 'debit' ? debit - credit : credit - debit;
    return { code: r.code, name: r.name, type: r.type, currency: r.currency, debitMinor: debit, creditMinor: credit, balanceMinor: balance };
  });
}

/** Sum of all debits minus all credits across every entry for a company. Must always be zero. */
export async function trialBalance(db: LedgerDb, companyId: string): Promise<{ debitMinor: Minor; creditMinor: Minor; netMinor: Minor; entryCount: number }> {
  const rows = await db.sql.query<{ debit: unknown; credit: unknown; n: unknown }>(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_minor END), 0) AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor END), 0) AS credit,
            COUNT(*) AS n
       FROM ${table(db, 'entries')} e JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
      WHERE t.company_id = $1`,
    [companyId],
  );
  const r = rows[0] ?? { debit: 0, credit: 0, n: 0 };
  const debit = toMinor(r.debit);
  const credit = toMinor(r.credit);
  return { debitMinor: debit, creditMinor: credit, netMinor: debit - credit, entryCount: Number(r.n) };
}

/** Convenience: read one account's signed balance by code. */
export async function balanceOf(db: LedgerDb, companyId: string, code: string, asOf?: Date | string): Promise<Minor> {
  const all = await accountBalances(db, companyId, asOf);
  const hit = all.find((a) => a.code === code);
  if (!hit) throw new LedgerError(`account ${code} not found for company ${companyId}`, 'unknown_account');
  return hit.balanceMinor;
}

export { ACCOUNT };

// ---------------------------------------------------------------------------

function translateDbError(err: unknown): Error {
  const msg = err instanceof Error ? err.message : String(err);
  if (/does not balance/i.test(msg)) return new LedgerError(msg, 'unbalanced');
  if (/at least two entries/i.test(msg)) return new LedgerError(msg, 'too_few_entries');
  if (/unknown account code/i.test(msg)) return new LedgerError(msg, 'unknown_account');
  if (/period .* is closed/i.test(msg)) return new LedgerError(msg, 'period_closed');
  return err instanceof Error ? err : new Error(msg);
}
