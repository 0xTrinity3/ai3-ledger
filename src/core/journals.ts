/**
 * Manual journals.
 *
 * A journal is a document that, once posted, is exactly one transaction. A
 * draft is editable and deletable and touches no report. A posted journal is
 * append-only like everything else: "deleting" it is a reversal, and the
 * journal shows as voided with a link to the reversing transaction. Numbers
 * are JNL-0001 upwards per company. Nothing here knows about Paperclip.
 */
import { LedgerError, postReversal, postTransaction, validatePost, type Direction, type Subject } from './ledger.js';
import { assertPositiveMinor, fromMinor, newId, table, toIso, toMinor, type LedgerDb, type Minor } from './sql.js';

export type JournalStatus = 'draft' | 'posted' | 'voided';

export interface JournalLineInput {
  accountCode: string;
  direction: Direction;
  amountMinor: Minor | number | string;
  description?: string | null;
  subject?: Subject;
}

export interface JournalLine {
  position: number;
  accountCode: string;
  accountName: string;
  direction: Direction;
  amountMinor: string;
  description: string | null;
  subject: Subject;
}

export interface Journal {
  id: string;
  publicId: string;
  companyId: string;
  number: string;
  occurredAt: string;
  narration: string;
  status: JournalStatus;
  transactionId: string | null;
  reversalId: string | null;
  createdBy: string;
  createdAt: string;
  postedAt: string | null;
  voidedAt: string | null;
  voidedBy: string | null;
  currency: string;
  debitMinor: string;
  creditMinor: string;
  lines: JournalLine[];
}

export interface CreateJournalInput {
  occurredAt: Date | string;
  narration?: string | null;
  lines: JournalLineInput[];
  createdBy?: string;
  /** Post straight away instead of leaving a draft. */
  post?: boolean;
}

const JOURNAL_REF = (id: string) => `journal:${id}`;

function normaliseLines(lines: JournalLineInput[]): Array<{ position: number; code: string; direction: Direction; amount: string; description: string | null; agent: string | null; project: string | null; goal: string | null }> {
  if (!Array.isArray(lines) || lines.length < 2) throw new LedgerError('a journal needs at least two lines', 'too_few_entries');
  if (lines.length > 200) throw new LedgerError('a journal may have at most 200 lines', 'invalid');
  let debit = 0n;
  let credit = 0n;
  const out = lines.map((l, i) => {
    const code = String(l.accountCode ?? '').trim();
    if (!code) throw new LedgerError(`line ${i + 1} needs an account`, 'invalid');
    if (l.direction !== 'debit' && l.direction !== 'credit') throw new LedgerError(`line ${i + 1} must be a debit or a credit`, 'invalid');
    const amount = assertPositiveMinor(l.amountMinor, `line ${i + 1} amount`);
    if (l.direction === 'debit') debit += amount;
    else credit += amount;
    return {
      position: i + 1,
      code,
      direction: l.direction,
      amount: fromMinor(amount),
      description: l.description?.trim().slice(0, 500) || null,
      agent: l.subject?.agent ?? null,
      project: l.subject?.project ?? null,
      goal: l.subject?.goal ?? null,
    };
  });
  if (debit !== credit) throw new LedgerError(`journal does not balance: debits ${fromMinor(debit)} vs credits ${fromMinor(credit)}`, 'unbalanced');
  return out;
}

async function assertAccountsExist(db: LedgerDb, companyId: string, codes: string[]): Promise<void> {
  const unique = [...new Set(codes)];
  const rows = await db.sql.query<{ code: string }>(
    `SELECT code FROM ${table(db, 'accounts')} WHERE company_id = $1 AND code = ANY(string_to_array($2::text, ','))`,
    [companyId, unique.join(',')],
  );
  const found = new Set(rows.map((r) => r.code));
  const missing = unique.filter((c) => !found.has(c));
  if (missing.length) throw new LedgerError(`unknown account code${missing.length === 1 ? '' : 's'} ${missing.join(', ')}`, 'unknown_account');
}

async function nextJournalNumber(db: LedgerDb, companyId: string): Promise<string> {
  const rows = await db.sql.query<{ n: unknown }>(
    `SELECT COALESCE(MAX(NULLIF(regexp_replace(number, '^JNL-', ''), '')::int), 0) + 1 AS n
       FROM ${table(db, 'journals')} WHERE company_id = $1 AND number ~ '^JNL-[0-9]+$'`,
    [companyId],
  );
  return `JNL-${String(Number(rows[0]?.n ?? 1)).padStart(4, '0')}`;
}

async function writeLines(db: LedgerDb, journalId: string, lines: ReturnType<typeof normaliseLines>): Promise<void> {
  const written = await db.sql.execute(
    `INSERT INTO ${table(db, 'journal_lines')} (id, journal_id, position, account_code, direction, amount_minor, description, subject_agent_ref, subject_project_ref, subject_goal_ref)
     SELECT gen_random_uuid(), $1::uuid, l.position, l.code, l.direction, l.amount, l.description, l.agent, l.project, l.goal
       FROM jsonb_to_recordset($2::jsonb) AS l(position int, code text, direction text, amount bigint, description text, agent text, project text, goal text)`,
    [journalId, JSON.stringify(lines)],
  );
  if (written.rowCount !== lines.length) throw new LedgerError('journal lines were not written', 'invalid');
}

/** Create a journal. A draft posts nothing; `post: true` posts it in the same call. */
export async function createJournal(db: LedgerDb, companyId: string, input: CreateJournalInput): Promise<Journal> {
  const occurredAt = toIso(input.occurredAt);
  if (Number.isNaN(Date.parse(occurredAt))) throw new LedgerError('occurredAt must be a date', 'invalid');
  const lines = normaliseLines(input.lines);
  await assertAccountsExist(db, companyId, lines.map((l) => l.code));
  const id = newId();
  const publicId = newId();
  let number = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    number = await nextJournalNumber(db, companyId);
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'journals')} (id, public_id, company_id, number, occurred_at, narration, status, created_by)
       VALUES ($1::uuid, $2::uuid, $3, $4, $5::timestamptz, $6, 'draft', $7)
       ON CONFLICT (company_id, number) DO NOTHING`,
      [id, publicId, companyId, number, occurredAt, String(input.narration ?? '').trim().slice(0, 1000), input.createdBy ?? 'board'],
    );
    if (r.rowCount === 1) break;
    number = '';
  }
  if (!number) throw new LedgerError('could not allocate a journal number', 'invalid');
  try {
    await writeLines(db, id, lines);
  } catch (err) {
    await db.sql.execute(`DELETE FROM ${table(db, 'journal_lines')} WHERE journal_id = $1::uuid`, [id]);
    await db.sql.execute(`DELETE FROM ${table(db, 'journals')} WHERE id = $1::uuid AND status = 'draft'`, [id]);
    throw err;
  }
  if (input.post) return postJournal(db, companyId, id, input.createdBy ? { createdBy: input.createdBy } : {});
  const j = await getJournal(db, companyId, id);
  if (!j) throw new LedgerError('journal was not written', 'invalid');
  return j;
}

/** Replace the date, narration and lines of a draft. */
export async function updateJournal(
  db: LedgerDb,
  companyId: string,
  id: string,
  input: { occurredAt?: Date | string; narration?: string | null; lines?: JournalLineInput[] },
): Promise<Journal> {
  const j = await getJournal(db, companyId, id);
  if (!j) throw new LedgerError(`journal ${id} not found for company ${companyId}`, 'invalid');
  if (j.status !== 'draft') throw new LedgerError(`${j.number} is ${j.status}; only a draft can be edited`, 'invalid');
  if (input.lines) {
    const lines = normaliseLines(input.lines);
    await assertAccountsExist(db, companyId, lines.map((l) => l.code));
    await db.sql.execute(`DELETE FROM ${table(db, 'journal_lines')} WHERE journal_id = $1::uuid`, [id]);
    await writeLines(db, id, lines);
  }
  await db.sql.execute(
    `UPDATE ${table(db, 'journals')} SET occurred_at = COALESCE($3::timestamptz, occurred_at), narration = COALESCE($4, narration)
      WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`,
    [companyId, id, input.occurredAt ? toIso(input.occurredAt) : null, input.narration === undefined ? null : String(input.narration ?? '').trim().slice(0, 1000)],
  );
  return (await getJournal(db, companyId, id)) ?? j;
}

/** Post a draft: the journal becomes one transaction. Idempotent. */
export async function postJournal(db: LedgerDb, companyId: string, id: string, opts: { createdBy?: string } = {}): Promise<Journal> {
  const j = await getJournal(db, companyId, id);
  if (!j) throw new LedgerError(`journal ${id} not found for company ${companyId}`, 'invalid');
  if (j.status === 'posted') return j;
  if (j.status === 'voided') throw new LedgerError(`${j.number} is voided`, 'invalid');
  const input = {
    companyId,
    occurredAt: j.occurredAt,
    description: j.narration ? `${j.number} · ${j.narration}` : j.number,
    sourcePlatform: 'manual',
    sourceKind: 'journal' as const,
    sourceRef: JOURNAL_REF(j.id),
    currency: j.currency,
    createdBy: opts.createdBy ?? j.createdBy,
    entries: j.lines.map((l) => ({ accountCode: l.accountCode, direction: l.direction, amountMinor: toMinor(l.amountMinor), subject: l.subject })),
  };
  validatePost(input);
  const r = await postTransaction(db, input);
  await db.sql.execute(
    `UPDATE ${table(db, 'journals')} SET status = 'posted', transaction_id = $3::uuid, posted_at = now() WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`,
    [companyId, id, r.transactionId],
  );
  const after = await getJournal(db, companyId, id);
  if (!after) throw new LedgerError('journal vanished while posting', 'invalid');
  return after;
}

/** Void a posted journal by reversing it. The books show both; reports net to nothing. */
export async function voidJournal(db: LedgerDb, companyId: string, id: string, opts: { createdBy?: string; occurredAt?: Date | string; reason?: string } = {}): Promise<Journal> {
  const j = await getJournal(db, companyId, id);
  if (!j) throw new LedgerError(`journal ${id} not found for company ${companyId}`, 'invalid');
  if (j.status === 'voided') return j;
  if (j.status !== 'posted' || !j.transactionId) throw new LedgerError(`${j.number} is a draft; delete it instead of voiding`, 'invalid');
  const r = await postReversal(db, companyId, j.transactionId, {
    occurredAt: opts.occurredAt ?? j.occurredAt,
    description: `Void ${j.number}${opts.reason ? ` · ${opts.reason}` : ''}`,
    createdBy: opts.createdBy ?? 'board',
  });
  await db.sql.execute(
    `UPDATE ${table(db, 'journals')} SET status = 'voided', reversal_id = $3::uuid, voided_at = now(), voided_by = $4 WHERE company_id = $1 AND id = $2::uuid AND status = 'posted'`,
    [companyId, id, r.transactionId, opts.createdBy ?? 'board'],
  );
  return (await getJournal(db, companyId, id)) ?? j;
}

/** Delete a draft. Posted journals cannot be deleted; void them. */
export async function deleteJournal(db: LedgerDb, companyId: string, id: string): Promise<{ deleted: boolean }> {
  const j = await getJournal(db, companyId, id);
  if (!j) throw new LedgerError(`journal ${id} not found for company ${companyId}`, 'invalid');
  if (j.status !== 'draft') throw new LedgerError(`${j.number} is ${j.status} and cannot be deleted; void it instead`, 'invalid');
  await db.sql.execute(`DELETE FROM ${table(db, 'journal_lines')} WHERE journal_id = $1::uuid`, [id]);
  const r = await db.sql.execute(`DELETE FROM ${table(db, 'journals')} WHERE company_id = $1 AND id = $2::uuid AND status = 'draft'`, [companyId, id]);
  return { deleted: r.rowCount === 1 };
}

interface JournalRow {
  id: string;
  public_id: string;
  company_id: string;
  number: string;
  occurred_at: string;
  narration: string;
  status: JournalStatus;
  transaction_id: string | null;
  reversal_id: string | null;
  created_by: string;
  created_at: string;
  posted_at: string | null;
  voided_at: string | null;
  voided_by: string | null;
  currency: string;
  debit: unknown;
  credit: unknown;
}

const SELECT = (db: LedgerDb) => `
  SELECT j.id, j.public_id, j.company_id, j.number, j.occurred_at::text AS occurred_at, j.narration, j.status, j.transaction_id, j.reversal_id,
         j.created_by, j.created_at::text AS created_at, j.posted_at::text AS posted_at, j.voided_at::text AS voided_at, j.voided_by,
         COALESCE((SELECT MIN(a.currency) FROM ${table(db, 'accounts')} a WHERE a.company_id = j.company_id), 'USD') AS currency,
         COALESCE((SELECT SUM(l.amount_minor) FROM ${table(db, 'journal_lines')} l WHERE l.journal_id = j.id AND l.direction = 'debit'), 0) AS debit,
         COALESCE((SELECT SUM(l.amount_minor) FROM ${table(db, 'journal_lines')} l WHERE l.journal_id = j.id AND l.direction = 'credit'), 0) AS credit
    FROM ${table(db, 'journals')} j`;

function fromRow(r: JournalRow, lines: JournalLine[]): Journal {
  return {
    id: r.id,
    publicId: r.public_id,
    companyId: r.company_id,
    number: r.number,
    occurredAt: r.occurred_at,
    narration: r.narration,
    status: r.status,
    transactionId: r.transaction_id,
    reversalId: r.reversal_id,
    createdBy: r.created_by,
    createdAt: r.created_at,
    postedAt: r.posted_at,
    voidedAt: r.voided_at,
    voidedBy: r.voided_by,
    currency: r.currency,
    debitMinor: fromMinor(toMinor(r.debit)),
    creditMinor: fromMinor(toMinor(r.credit)),
    lines,
  };
}

async function linesOf(db: LedgerDb, companyId: string, journalIds: string[]): Promise<Map<string, JournalLine[]>> {
  const out = new Map<string, JournalLine[]>();
  if (journalIds.length === 0) return out;
  const rows = await db.sql.query<{ journal_id: string; position: number; account_code: string; name: string | null; direction: Direction; amount_minor: unknown; description: string | null; subject_agent_ref: string | null; subject_project_ref: string | null; subject_goal_ref: string | null }>(
    `SELECT l.journal_id, l.position, l.account_code, a.name, l.direction, l.amount_minor, l.description, l.subject_agent_ref, l.subject_project_ref, l.subject_goal_ref
       FROM ${table(db, 'journal_lines')} l
       LEFT JOIN ${table(db, 'accounts')} a ON a.company_id = $1 AND a.code = l.account_code
      WHERE l.journal_id = ANY(string_to_array($2::text, ',')::uuid[])
      ORDER BY l.journal_id, l.position`,
    [companyId, journalIds.join(',')],
  );
  for (const l of rows) {
    const list = out.get(l.journal_id) ?? [];
    list.push({
      position: Number(l.position),
      accountCode: l.account_code,
      accountName: l.name ?? '',
      direction: l.direction,
      amountMinor: fromMinor(toMinor(l.amount_minor)),
      description: l.description,
      subject: {
        ...(l.subject_agent_ref ? { agent: l.subject_agent_ref } : {}),
        ...(l.subject_project_ref ? { project: l.subject_project_ref } : {}),
        ...(l.subject_goal_ref ? { goal: l.subject_goal_ref } : {}),
      },
    });
    out.set(l.journal_id, list);
  }
  return out;
}

export async function getJournal(db: LedgerDb, companyId: string, id: string): Promise<Journal | null> {
  const rows = await db.sql.query<JournalRow>(`${SELECT(db)} WHERE j.company_id = $1 AND j.id = $2::uuid`, [companyId, id]);
  const r = rows[0];
  if (!r) return null;
  const lines = await linesOf(db, companyId, [id]);
  return fromRow(r, lines.get(id) ?? []);
}

/** The journal a posted transaction came from, if any. */
export async function journalForTransaction(db: LedgerDb, companyId: string, transactionId: string): Promise<Journal | null> {
  const rows = await db.sql.query<JournalRow>(`${SELECT(db)} WHERE j.company_id = $1 AND (j.transaction_id = $2::uuid OR j.reversal_id = $2::uuid)`, [companyId, transactionId]);
  const r = rows[0];
  if (!r) return null;
  const lines = await linesOf(db, companyId, [r.id]);
  return fromRow(r, lines.get(r.id) ?? []);
}

export async function listJournals(db: LedgerDb, companyId: string, opts: { status?: JournalStatus; limit?: number } = {}): Promise<Journal[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 1000);
  const rows = await db.sql.query<JournalRow>(
    `${SELECT(db)} WHERE j.company_id = $1 AND ($2::text IS NULL OR j.status = $2::text) ORDER BY j.occurred_at DESC, j.created_at DESC LIMIT $3::int`,
    [companyId, opts.status ?? null, limit],
  );
  const lines = await linesOf(db, companyId, rows.map((r) => r.id));
  return rows.map((r) => fromRow(r, lines.get(r.id) ?? []));
}
