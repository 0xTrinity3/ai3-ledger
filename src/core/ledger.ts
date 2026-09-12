/**
 * The double-entry core.
 *
 * Rules enforced here and, where the host allows it, again in the database:
 *  - every transaction sums to zero
 *  - the ledger is append-only; corrections are reversing transactions
 *  - amounts are positive bigint minor units; sign comes from direction
 *  - a repeated (company, platform, kind, ref) is a no-op, not an error
 *  - reports only ever count transactions whose status is 'posted'
 *
 * Nothing in this file knows about Paperclip.
 */
import { ACCOUNT, SEED_ACCOUNTS, normalSide, type AccountType } from './accounts.js';
import {
  assertCurrency,
  assertPositiveMinor,
  fromMinor,
  newId,
  table,
  toIso,
  toMinor,
  type LedgerDb,
  type Minor,
} from './sql.js';

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
export type SourceKind = 'cost_sweep' | 'funding' | 'invoice' | 'payment' | 'manual' | 'reversal' | 'journal' | 'bill' | 'conversion';

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

interface EntryPayload {
  code: string;
  direction: Direction;
  amount: string;
  agent: string | null;
  project: string | null;
  goal: string | null;
  work: string | null;
}

function entryPayload(entries: EntryInput[]): EntryPayload[] {
  return entries.map((e) => ({
    code: e.accountCode,
    direction: e.direction,
    amount: fromMinor(assertPositiveMinor(e.amountMinor, 'entry amount')),
    agent: e.subject?.agent ?? null,
    project: e.subject?.project ?? null,
    goal: e.subject?.goal ?? null,
    work: e.subject?.work ?? null,
  }));
}

/** Post a balanced transaction. A duplicate source ref returns the existing id with inserted=false. */
export async function postTransaction(db: LedgerDb, input: PostInput): Promise<PostResult> {
  const { currency, entries } = validatePost(input);
  const payload = entryPayload(entries);
  if (db.posting === 'statements') return postWithStatements(db, input, currency, payload);
  return postWithFunction(db, input, currency, payload);
}

/** One atomic call to ledger_post(). Requires the function and triggers from migrations/0001_init.sql. */
async function postWithFunction(db: LedgerDb, input: PostInput, currency: string, payload: EntryPayload[]): Promise<PostResult> {
  let rows: Array<{ id: string; public_id: string; inserted: boolean }>;
  try {
    rows = await db.sql.query(
      `SELECT id, public_id, inserted FROM ${table(db, 'ledger_post')}($1, $2::timestamptz, $3, $4, $5, $6, $7, $8::uuid, $9, $10::jsonb)`,
      [
        input.companyId,
        toIso(input.occurredAt),
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

/**
 * Plain-statement posting for sandboxed hosts. Every call is one INSERT,
 * UPDATE or DELETE with no function calls, matching Paperclip's
 * `ctx.db.execute` rules. Sequence:
 *
 *   1. INSERT the transaction as 'pending' (ON CONFLICT DO NOTHING on the
 *      source tuple). rowCount 0 means the tuple already exists: look it up
 *      and report inserted=false without writing anything.
 *   2. INSERT every entry in one statement from a JSON array joined to the
 *      chart of accounts. Fewer rows than entries means an unknown account:
 *      delete what was written and raise.
 *   3. UPDATE status to 'posted'. Until this lands the transaction is invisible
 *      to every report, so a crash between steps leaves nothing to reconcile
 *      beyond a stale 'pending' row that `cleanupPending` removes.
 */
async function postWithStatements(db: LedgerDb, input: PostInput, currency: string, payload: EntryPayload[]): Promise<PostResult> {
  const closed = await closedPeriodFor(db, input.companyId, input.occurredAt);
  if (closed) throw new LedgerError(`period ${closed} is closed`, 'period_closed');

  const id = newId();
  const publicId = newId();
  const sourceRef = input.sourceRef ?? null;

  const ins = await db.sql.execute(
    `INSERT INTO ${table(db, 'transactions')}
       (id, public_id, company_id, occurred_at, description, source_platform, source_kind, source_ref, created_by, reverses_id, status)
     VALUES ($1::uuid, $2::uuid, $3, $4::timestamptz, $5, $6, $7, $8, $9, $10::uuid, 'pending')
     ON CONFLICT (company_id, source_platform, source_kind, source_ref) WHERE source_ref IS NOT NULL DO NOTHING`,
    [
      id,
      publicId,
      input.companyId,
      toIso(input.occurredAt),
      input.description ?? '',
      input.sourcePlatform,
      input.sourceKind,
      sourceRef,
      input.createdBy ?? 'system',
      input.reversesId ?? null,
    ],
  );

  if (ins.rowCount === 0) {
    const existing = await db.sql.query<{ id: string; public_id: string }>(
      `SELECT id, public_id FROM ${table(db, 'transactions')}
        WHERE company_id = $1 AND source_platform = $2 AND source_kind = $3 AND source_ref = $4`,
      [input.companyId, input.sourcePlatform, input.sourceKind, sourceRef],
    );
    const row = existing[0];
    if (!row) throw new LedgerError('duplicate transaction reported but not found', 'invalid');
    return { ok: true, transactionId: row.id, publicId: row.public_id, inserted: false };
  }

  const written = await db.sql.execute(
    `INSERT INTO ${table(db, 'entries')}
       (id, transaction_id, account_id, subject_agent_ref, subject_project_ref, subject_goal_ref, subject_work_ref, direction, amount_minor, currency)
     SELECT gen_random_uuid(), $1::uuid, a.id, e.agent, e.project, e.goal, e.work, e.direction, e.amount, $3
       FROM jsonb_to_recordset($4::jsonb)
            AS e(code text, direction text, amount bigint, agent text, project text, goal text, work text)
       JOIN ${table(db, 'accounts')} a ON a.company_id = $2 AND a.code = e.code`,
    [id, input.companyId, currency, JSON.stringify(payload)],
  );

  if (written.rowCount !== payload.length) {
    await db.sql.execute(`DELETE FROM ${table(db, 'entries')} WHERE transaction_id = $1::uuid`, [id]);
    await db.sql.execute(`DELETE FROM ${table(db, 'transactions')} WHERE id = $1::uuid AND status = 'pending'`, [id]);
    throw new LedgerError(
      `${payload.length - written.rowCount} of ${payload.length} entries referenced an unknown account code for company ${input.companyId}`,
      'unknown_account',
    );
  }

  await db.sql.execute(`UPDATE ${table(db, 'transactions')} SET status = 'posted' WHERE id = $1::uuid AND status = 'pending'`, [id]);
  return { ok: true, transactionId: id, publicId, inserted: true };
}

/** Name of the closed period a date falls into, or null. Mirrors the ledger_period_open trigger. */
async function closedPeriodFor(db: LedgerDb, companyId: string, occurredAt: Date | string): Promise<string | null> {
  const rows = await db.sql.query<{ name: string }>(
    `SELECT starts_on::text || '..' || ends_on::text AS name
       FROM ${table(db, 'periods')}
      WHERE company_id = $1 AND status = 'closed'
        AND ($2::timestamptz AT TIME ZONE 'UTC')::date BETWEEN starts_on AND ends_on
      LIMIT 1`,
    [companyId, toIso(occurredAt)],
  );
  return rows[0]?.name ?? null;
}

/**
 * Remove transactions that never reached 'posted'. Only meaningful in
 * statements mode; in function mode nothing is ever pending. Returns how many
 * transactions were removed.
 */
export async function cleanupPending(db: LedgerDb, olderThanMinutes = 10): Promise<number> {
  const minutes = Math.max(0, Math.floor(olderThanMinutes));
  await db.sql.execute(
    `DELETE FROM ${table(db, 'entries')}
      WHERE transaction_id IN (
        SELECT id FROM ${table(db, 'transactions')}
         WHERE status = 'pending' AND created_at < now() - ($1::int * interval '1 minute'))`,
    [minutes],
  );
  const r = await db.sql.execute(
    `DELETE FROM ${table(db, 'transactions')}
      WHERE status = 'pending' AND created_at < now() - ($1::int * interval '1 minute')`,
    [minutes],
  );
  return r.rowCount;
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
      WHERE t.id = $1::uuid AND t.company_id = $2 AND t.status = 'posted'
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
  accountId: string;
  parentId: string | null;
}

/**
 * Balances of every account for a company over a window of posted
 * transactions. `asOf` is inclusive; `from` is inclusive and mostly useful for
 * income and expense figures over a period.
 */
export async function accountBalances(
  db: LedgerDb,
  companyId: string,
  asOf?: Date | string,
  from?: Date | string,
): Promise<AccountBalance[]> {
  const asOfIso = asOf ? toIso(asOf) : null;
  const fromIso = from ? toIso(from) : null;
  const rows = await db.sql.query<{
    code: string;
    name: string;
    type: AccountType;
    currency: string;
    parent_id: string | null;
    account_id: string;
    debit: unknown;
    credit: unknown;
  }>(
    `SELECT a.code, a.name, a.type, a.currency, a.parent_id, a.id AS account_id,
            COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_minor END), 0) AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor END), 0) AS credit
       FROM ${table(db, 'accounts')} a
       LEFT JOIN (
            SELECT e.account_id, e.direction, e.amount_minor
              FROM ${table(db, 'entries')} e
              JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
             WHERE t.status = 'posted'
               AND ($2::timestamptz IS NULL OR t.occurred_at <= $2::timestamptz)
               AND ($3::timestamptz IS NULL OR t.occurred_at >= $3::timestamptz)
       ) e ON e.account_id = a.id
      WHERE a.company_id = $1
      GROUP BY a.id, a.code, a.name, a.type, a.currency, a.parent_id
      ORDER BY a.code`,
    [companyId, asOfIso, fromIso],
  );
  return rows.map((r) => {
    const debit = toMinor(r.debit);
    const credit = toMinor(r.credit);
    const balance = normalSide(r.type) === 'debit' ? debit - credit : credit - debit;
    return { code: r.code, name: r.name, type: r.type, currency: r.currency, accountId: r.account_id, parentId: r.parent_id, debitMinor: debit, creditMinor: credit, balanceMinor: balance };
  });
}

/** Sum of all debits minus all credits across every posted entry for a company. Must always be zero. */
export async function trialBalance(db: LedgerDb, companyId: string): Promise<{ debitMinor: Minor; creditMinor: Minor; netMinor: Minor; entryCount: number }> {
  const rows = await db.sql.query<{ debit: unknown; credit: unknown; n: unknown }>(
    `SELECT COALESCE(SUM(CASE WHEN e.direction = 'debit'  THEN e.amount_minor END), 0) AS debit,
            COALESCE(SUM(CASE WHEN e.direction = 'credit' THEN e.amount_minor END), 0) AS credit,
            COUNT(*) AS n
       FROM ${table(db, 'entries')} e JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
      WHERE t.company_id = $1 AND t.status = 'posted'`,
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

export interface TransactionRow {
  id: string;
  publicId: string;
  occurredAt: string;
  description: string;
  sourcePlatform: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
  reversesId: string | null;
  createdBy: string;
  entries: Array<{ accountCode: string; accountName: string; direction: Direction; amountMinor: string; currency: string; subject: Subject }>;
}

export interface ListTransactionsOptions {
  from?: Date | string;
  to?: Date | string;
  agentRef?: string;
  limit?: number;
}

/** Posted transactions for a company, newest first, with their entries. */
/** The posted transaction a platform reference points at, if any. Used to tie a chain line to the payment that caused it. */
export async function findTransactionBySourceRef(db: LedgerDb, companyId: string, sourcePlatform: string, sourceRef: string): Promise<string | null> {
  const rows = await db.sql.query<{ id: string }>(
    `SELECT id FROM ${table(db, 'transactions')} WHERE company_id = $1 AND source_platform = $2 AND source_ref = $3 AND status = 'posted' ORDER BY created_at DESC LIMIT 1`,
    [companyId, sourcePlatform, sourceRef],
  );
  return rows[0]?.id ?? null;
}

export async function listTransactions(db: LedgerDb, companyId: string, opts: ListTransactionsOptions = {}): Promise<TransactionRow[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 500);
  const heads = await db.sql.query<{
    id: string;
    public_id: string;
    occurred_at: string | Date;
    description: string;
    source_platform: string;
    source_kind: SourceKind;
    source_ref: string | null;
    reverses_id: string | null;
    created_by: string;
  }>(
    `SELECT t.id, t.public_id, t.occurred_at, t.description, t.source_platform, t.source_kind, t.source_ref, t.reverses_id, t.created_by
       FROM ${table(db, 'transactions')} t
      WHERE t.company_id = $1 AND t.status = 'posted'
        AND ($2::timestamptz IS NULL OR t.occurred_at >= $2::timestamptz)
        AND ($3::timestamptz IS NULL OR t.occurred_at <= $3::timestamptz)
        AND ($4::text IS NULL OR EXISTS (
              SELECT 1 FROM ${table(db, 'entries')} x WHERE x.transaction_id = t.id AND x.subject_agent_ref = $4::text))
      ORDER BY t.occurred_at DESC, t.created_at DESC
      LIMIT $5::int`,
    [companyId, opts.from ? toIso(opts.from) : null, opts.to ? toIso(opts.to) : null, opts.agentRef ?? null, limit],
  );
  if (heads.length === 0) return [];
  const ids = heads.map((h) => h.id);
  const lines = await db.sql.query<{
    transaction_id: string;
    code: string;
    name: string;
    direction: Direction;
    amount_minor: unknown;
    currency: string;
    subject_agent_ref: string | null;
    subject_project_ref: string | null;
    subject_goal_ref: string | null;
    subject_work_ref: string | null;
  }>(
    `SELECT e.transaction_id, a.code, a.name, e.direction, e.amount_minor, e.currency,
            e.subject_agent_ref, e.subject_project_ref, e.subject_goal_ref, e.subject_work_ref
       FROM ${table(db, 'entries')} e JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
      WHERE e.transaction_id = ANY(string_to_array($1::text, ',')::uuid[])
      ORDER BY e.direction, a.code`,
    [ids.join(',')],
  );
  const byTx = new Map<string, TransactionRow['entries']>();
  for (const l of lines) {
    const list = byTx.get(l.transaction_id) ?? [];
    list.push({
      accountCode: l.code,
      accountName: l.name,
      direction: l.direction,
      amountMinor: fromMinor(toMinor(l.amount_minor)),
      currency: l.currency,
      subject: {
        ...(l.subject_agent_ref ? { agent: l.subject_agent_ref } : {}),
        ...(l.subject_project_ref ? { project: l.subject_project_ref } : {}),
        ...(l.subject_goal_ref ? { goal: l.subject_goal_ref } : {}),
        ...(l.subject_work_ref ? { work: l.subject_work_ref } : {}),
      },
    });
    byTx.set(l.transaction_id, list);
  }
  return heads.map((h) => ({
    id: h.id,
    publicId: h.public_id,
    occurredAt: h.occurred_at instanceof Date ? h.occurred_at.toISOString() : String(h.occurred_at),
    description: h.description,
    sourcePlatform: h.source_platform,
    sourceKind: h.source_kind,
    sourceRef: h.source_ref,
    reversesId: h.reverses_id,
    createdBy: h.created_by,
    entries: byTx.get(h.id) ?? [],
  }));
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

// ---------------------------------------------------------------------------
// Drill-down: the entries behind a figure, and one transaction with its source
// ---------------------------------------------------------------------------

export interface EntryFilter {
  /** One account, or every account of a type. */
  accountCode?: string;
  accountType?: AccountType;
  /** Include the sub-accounts of `accountCode` (bank accounts under Treasury). */
  withChildren?: boolean;
  from?: Date | string;
  to?: Date | string;
  /** Restrict to one subject value, as the P&L groups do. */
  groupBy?: 'agent' | 'project' | 'goal';
  groupKey?: string | null;
  sourceKind?: SourceKind;
  limit?: number;
}

export interface EntryRow {
  entryId: string;
  transactionId: string;
  occurredAt: string;
  description: string;
  sourcePlatform: string;
  sourceKind: SourceKind;
  sourceRef: string | null;
  reversesId: string | null;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  direction: Direction;
  amountMinor: string;
  /** Signed on the account's normal side: what this entry did to the figure the person clicked. */
  signedMinor: string;
  /** Running balance on the normal side, oldest first, over the rows returned. */
  runningMinor: string;
  currency: string;
  subject: Subject;
}

export interface EntryList {
  companyId: string;
  filter: EntryFilter;
  currency: string | null;
  rows: EntryRow[];
  totalMinor: string;
  debitMinor: string;
  creditMinor: string;
  count: number;
  truncated: boolean;
}

const GROUP_COL: Record<'agent' | 'project' | 'goal', string> = { agent: 'subject_agent_ref', project: 'subject_project_ref', goal: 'subject_goal_ref' };

/** Posted entries matching a filter, oldest first, with a running balance. This is what a click on a report figure opens. */
export async function listEntries(db: LedgerDb, companyId: string, filter: EntryFilter = {}): Promise<EntryList> {
  const limit = Math.min(Math.max(Math.floor(filter.limit ?? 500), 1), 5000);
  if (filter.groupBy && !(filter.groupBy in GROUP_COL)) throw new LedgerError('groupBy must be agent, project or goal', 'invalid');
  const groupExpr = filter.groupBy ? `e.${GROUP_COL[filter.groupBy]}` : 'NULL::text';
  const rows = await db.sql.query<{
    entry_id: string; transaction_id: string; occurred_at: string; description: string; source_platform: string; source_kind: SourceKind; source_ref: string | null; reverses_id: string | null;
    code: string; name: string; type: AccountType; direction: Direction; amount_minor: unknown; currency: string;
    subject_agent_ref: string | null; subject_project_ref: string | null; subject_goal_ref: string | null; subject_work_ref: string | null;
  }>(
    `SELECT e.id AS entry_id, t.id AS transaction_id, t.occurred_at::text AS occurred_at, t.description, t.source_platform, t.source_kind, t.source_ref, t.reverses_id,
            a.code, a.name, a.type, e.direction, e.amount_minor, e.currency,
            e.subject_agent_ref, e.subject_project_ref, e.subject_goal_ref, e.subject_work_ref
       FROM ${table(db, 'entries')} e
       JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
       JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
       LEFT JOIN ${table(db, 'accounts')} parent ON parent.id = a.parent_id
      WHERE t.company_id = $1 AND t.status = 'posted'
        AND ($2::text IS NULL OR a.code = $2::text OR ($3::boolean AND parent.code = $2::text))
        AND ($4::text IS NULL OR a.type = $4::text)
        AND ($5::timestamptz IS NULL OR t.occurred_at >= $5::timestamptz)
        AND ($6::timestamptz IS NULL OR t.occurred_at <= $6::timestamptz)
        AND ($7::boolean = false OR ${groupExpr} IS NOT DISTINCT FROM $8::text)
        AND ($9::text IS NULL OR t.source_kind = $9::text)
      ORDER BY t.occurred_at ASC, t.created_at ASC, e.direction ASC, a.code ASC
      LIMIT $10::int`,
    [
      companyId,
      filter.accountCode ?? null,
      filter.withChildren === true,
      filter.accountType ?? null,
      filter.from ? toIso(filter.from) : null,
      filter.to ? toIso(filter.to) : null,
      Boolean(filter.groupBy),
      filter.groupKey ?? null,
      filter.sourceKind ?? null,
      limit + 1,
    ],
  );
  const truncated = rows.length > limit;
  const kept = truncated ? rows.slice(0, limit) : rows;
  let running = 0n;
  let debit = 0n;
  let credit = 0n;
  const out: EntryRow[] = kept.map((r) => {
    const amount = toMinor(r.amount_minor);
    const signed = normalSide(r.type) === r.direction ? amount : -amount;
    running += signed;
    if (r.direction === 'debit') debit += amount;
    else credit += amount;
    return {
      entryId: r.entry_id,
      transactionId: r.transaction_id,
      occurredAt: r.occurred_at,
      description: r.description,
      sourcePlatform: r.source_platform,
      sourceKind: r.source_kind,
      sourceRef: r.source_ref,
      reversesId: r.reverses_id,
      accountCode: r.code,
      accountName: r.name,
      accountType: r.type,
      direction: r.direction,
      amountMinor: fromMinor(amount),
      signedMinor: fromMinor(signed),
      runningMinor: fromMinor(running),
      currency: r.currency,
      subject: {
        ...(r.subject_agent_ref ? { agent: r.subject_agent_ref } : {}),
        ...(r.subject_project_ref ? { project: r.subject_project_ref } : {}),
        ...(r.subject_goal_ref ? { goal: r.subject_goal_ref } : {}),
        ...(r.subject_work_ref ? { work: r.subject_work_ref } : {}),
      },
    };
  });
  return {
    companyId,
    filter,
    currency: out[0]?.currency ?? null,
    rows: out,
    totalMinor: fromMinor(running),
    debitMinor: fromMinor(debit),
    creditMinor: fromMinor(credit),
    count: out.length,
    truncated,
  };
}

/** One transaction with its lines, whatever reversed it, and whatever it reversed. */
export async function getTransaction(db: LedgerDb, companyId: string, id: string): Promise<(TransactionRow & { status: 'pending' | 'posted'; reversedBy: string | null }) | null> {
  const heads = await db.sql.query<{ id: string; public_id: string; occurred_at: string; description: string; source_platform: string; source_kind: SourceKind; source_ref: string | null; reverses_id: string | null; created_by: string; status: 'pending' | 'posted'; reversed_by: string | null }>(
    `SELECT t.id, t.public_id, t.occurred_at::text AS occurred_at, t.description, t.source_platform, t.source_kind, t.source_ref, t.reverses_id, t.created_by, t.status,
            (SELECT r.id FROM ${table(db, 'transactions')} r WHERE r.reverses_id = t.id AND r.status = 'posted' ORDER BY r.created_at DESC LIMIT 1) AS reversed_by
       FROM ${table(db, 'transactions')} t
      WHERE t.company_id = $1 AND t.id = $2::uuid`,
    [companyId, id],
  );
  const h = heads[0];
  if (!h) return null;
  const lines = await db.sql.query<{ code: string; name: string; direction: Direction; amount_minor: unknown; currency: string; subject_agent_ref: string | null; subject_project_ref: string | null; subject_goal_ref: string | null; subject_work_ref: string | null }>(
    `SELECT a.code, a.name, e.direction, e.amount_minor, e.currency, e.subject_agent_ref, e.subject_project_ref, e.subject_goal_ref, e.subject_work_ref
       FROM ${table(db, 'entries')} e JOIN ${table(db, 'accounts')} a ON a.id = e.account_id
      WHERE e.transaction_id = $1::uuid
      ORDER BY e.direction, a.code`,
    [id],
  );
  return {
    id: h.id,
    publicId: h.public_id,
    occurredAt: h.occurred_at,
    description: h.description,
    sourcePlatform: h.source_platform,
    sourceKind: h.source_kind,
    sourceRef: h.source_ref,
    reversesId: h.reverses_id,
    createdBy: h.created_by,
    status: h.status,
    reversedBy: h.reversed_by,
    entries: lines.map((l) => ({
      accountCode: l.code,
      accountName: l.name,
      direction: l.direction,
      amountMinor: fromMinor(toMinor(l.amount_minor)),
      currency: l.currency,
      subject: {
        ...(l.subject_agent_ref ? { agent: l.subject_agent_ref } : {}),
        ...(l.subject_project_ref ? { project: l.subject_project_ref } : {}),
        ...(l.subject_goal_ref ? { goal: l.subject_goal_ref } : {}),
        ...(l.subject_work_ref ? { work: l.subject_work_ref } : {}),
      },
    })),
  };
}
