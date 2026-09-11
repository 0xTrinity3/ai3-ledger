/**
 * Bank accounts and statement lines.
 *
 * A bank account is where money actually sits: a bank, a card, a Stripe
 * balance, a wallet. Each one owns a ledger sub-account under 1000 Treasury,
 * so Treasury stays the total and the position page needs no special case.
 * Statement lines are the bank's version of events: append-only, never
 * edited, deduplicated so the same month can be uploaded twice safely.
 */
import { createHash } from 'node:crypto';
import { ACCOUNT } from './accounts.js';
import { LedgerError } from './ledger.js';
import { assertCurrency, fromMinor, newId, table, toIso, toMinor, type LedgerDb, type Minor } from './sql.js';
import type { ParsedLine } from './statements.js';

export type BankKind = 'bank' | 'card' | 'stripe' | 'wallet';
export type BankFeed = 'upload' | 'stripe' | 'aggregator';
export type LineStatus = 'unreconciled' | 'matched' | 'created' | 'transferred' | 'excluded';

export interface BankAccount {
  id: string;
  companyId: string;
  name: string;
  kind: BankKind;
  currency: string;
  feed: BankFeed;
  accountId: string;
  accountCode: string;
  externalRef: string | null;
  connectedAt: string | null;
  createdAt: string;
  ledgerBalanceMinor: string;
  statementBalanceMinor: string | null;
  lastLineAt: string | null;
  unreconciled: number;
}

export interface Proposal {
  kind: 'match' | 'batch' | 'create' | 'transfer' | 'ask';
  confidence: number; // 0..100
  reason: string;
  /** ledger transactions to link (match, batch) */
  transactionIds?: string[];
  /** account to post against (create) */
  accountCode?: string;
  contactName?: string;
  /** other bank account and its line (transfer) */
  otherBankAccountId?: string;
  otherLineId?: string;
  /** the invoice a money-in line pays (create against receivables) */
  invoiceId?: string;
  /** what a person could pick when we ask */
  options?: Array<{ label: string; decision: Decision }>;
  ruleId?: string;
}

export type Decision =
  | { kind: 'match'; transactionIds: string[] }
  | { kind: 'create'; accountCode: string; description?: string; contactName?: string }
  | { kind: 'transfer'; otherBankAccountId: string; otherLineId?: string }
  | { kind: 'exclude'; reason?: string };

export interface StatementLine {
  id: string;
  companyId: string;
  bankAccountId: string;
  postedAt: string;
  amountMinor: string;
  description: string;
  payee: string | null;
  reference: string | null;
  externalId: string | null;
  balanceAfterMinor: string | null;
  status: LineStatus;
  reconciledTransactionId: string | null;
  reconciledAt: string | null;
  reconciledBy: string | null;
  proposal: Proposal | null;
  proposedAt: string | null;
  importBatch: string | null;
}

// ---------------------------------------------------------------------------
// Bank accounts
// ---------------------------------------------------------------------------

interface BankRow {
  id: string; company_id: string; name: string; kind: BankKind; currency: string; feed: BankFeed; account_id: string; account_code: string;
  external_ref: string | null; connected_at: string | null; created_at: string; ledger_debit: unknown; ledger_credit: unknown;
  statement_balance: unknown; last_line_at: string | null; unreconciled: unknown;
}

const BANK_SELECT = (db: LedgerDb) => `
  SELECT b.id, b.company_id, b.name, b.kind, b.currency, b.feed, b.account_id, a.code AS account_code, b.external_ref,
         b.connected_at::text AS connected_at, b.created_at::text AS created_at,
         COALESCE((SELECT SUM(e.amount_minor) FROM ${table(db, 'entries')} e JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
                    WHERE e.account_id = b.account_id AND t.status = 'posted' AND e.direction = 'debit'), 0) AS ledger_debit,
         COALESCE((SELECT SUM(e.amount_minor) FROM ${table(db, 'entries')} e JOIN ${table(db, 'transactions')} t ON t.id = e.transaction_id
                    WHERE e.account_id = b.account_id AND t.status = 'posted' AND e.direction = 'credit'), 0) AS ledger_credit,
         (SELECT COALESCE(l.balance_after_minor, (SELECT SUM(x.amount_minor) FROM ${table(db, 'statement_lines')} x WHERE x.bank_account_id = b.id AND x.status <> 'excluded'))
            FROM ${table(db, 'statement_lines')} l WHERE l.bank_account_id = b.id AND l.status <> 'excluded' ORDER BY l.posted_at DESC, l.created_at DESC LIMIT 1) AS statement_balance,
         (SELECT MAX(l.posted_at)::text FROM ${table(db, 'statement_lines')} l WHERE l.bank_account_id = b.id) AS last_line_at,
         (SELECT COUNT(*) FROM ${table(db, 'statement_lines')} l WHERE l.bank_account_id = b.id AND l.status = 'unreconciled') AS unreconciled
    FROM ${table(db, 'bank_accounts')} b JOIN ${table(db, 'accounts')} a ON a.id = b.account_id`;

function bankFromRow(r: BankRow): BankAccount {
  const ledger = toMinor(r.ledger_debit) - toMinor(r.ledger_credit);
  return {
    id: r.id, companyId: r.company_id, name: r.name, kind: r.kind, currency: r.currency, feed: r.feed, accountId: r.account_id, accountCode: r.account_code,
    externalRef: r.external_ref, connectedAt: r.connected_at, createdAt: r.created_at,
    ledgerBalanceMinor: fromMinor(ledger),
    statementBalanceMinor: r.statement_balance === null || r.statement_balance === undefined ? null : fromMinor(toMinor(r.statement_balance)),
    lastLineAt: r.last_line_at, unreconciled: Number(r.unreconciled ?? 0),
  };
}

export async function listBankAccounts(db: LedgerDb, companyId: string): Promise<BankAccount[]> {
  const rows = await db.sql.query<BankRow>(`${BANK_SELECT(db)} WHERE b.company_id = $1 AND b.archived_at IS NULL ORDER BY b.created_at`, [companyId]);
  return rows.map(bankFromRow);
}

export async function getBankAccount(db: LedgerDb, companyId: string, id: string): Promise<BankAccount | null> {
  const rows = await db.sql.query<BankRow>(`${BANK_SELECT(db)} WHERE b.company_id = $1 AND b.id = $2::uuid`, [companyId, id]);
  return rows[0] ? bankFromRow(rows[0]) : null;
}

/** Next free sub-account code under Treasury: 1001, 1002, … */
async function nextBankCode(db: LedgerDb, companyId: string): Promise<string> {
  const rows = await db.sql.query<{ code: string }>(`SELECT code FROM ${table(db, 'accounts')} WHERE company_id = $1 AND code ~ '^10[0-9][1-9]$'`, [companyId]);
  const used = new Set(rows.map((r) => r.code));
  for (let n = 1001; n <= 1099; n++) if (!used.has(String(n)) && String(n).slice(-1) !== '0') return String(n);
  throw new LedgerError('no free bank sub-account code left', 'invalid');
}

export async function createBankAccount(
  db: LedgerDb,
  companyId: string,
  input: { name: string; kind: BankKind; currency: string; feed?: BankFeed; externalRef?: string | null },
): Promise<BankAccount> {
  const name = String(input.name ?? '').trim();
  if (name.length < 1 || name.length > 120) throw new LedgerError('a bank account needs a name of 1 to 120 characters', 'invalid');
  if (!['bank', 'card', 'stripe', 'wallet'].includes(input.kind)) throw new LedgerError('kind must be bank, card, stripe or wallet', 'invalid');
  const currency = assertCurrency(input.currency);
  const feed: BankFeed = input.feed ?? (input.kind === 'stripe' ? 'stripe' : 'upload');
  const treasury = await db.sql.query<{ id: string }>(`SELECT id FROM ${table(db, 'accounts')} WHERE company_id = $1 AND code = $2`, [companyId, ACCOUNT.TREASURY]);
  const parentId = treasury[0]?.id;
  if (!parentId) throw new LedgerError('seed the chart of accounts first', 'invalid');
  const accountId = newId();
  const code = await nextBankCode(db, companyId);
  await db.sql.execute(
    `INSERT INTO ${table(db, 'accounts')} (id, company_id, code, name, type, parent_id, currency, is_system)
     VALUES ($1::uuid, $2, $3, $4, 'asset', $5::uuid, $6, false) ON CONFLICT (company_id, code) DO NOTHING`,
    [accountId, companyId, code, name, parentId, currency],
  );
  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'bank_accounts')} (id, company_id, name, kind, currency, feed, account_id, external_ref, connected_at)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7::uuid, $8, $9::timestamptz)`,
    [id, companyId, name, input.kind, currency, feed, accountId, input.externalRef ?? null, feed === 'upload' ? null : new Date().toISOString()],
  );
  const b = await getBankAccount(db, companyId, id);
  if (!b) throw new LedgerError('bank account was not written', 'invalid');
  return b;
}

// ---------------------------------------------------------------------------
// Statement lines
// ---------------------------------------------------------------------------

export function dedupeKey(line: ParsedLine): string {
  if (line.externalId) return `id:${line.externalId}`;
  const norm = line.description.toLowerCase().replace(/\s+/g, ' ').trim();
  return `h:${createHash('sha256').update(`${line.postedAt.slice(0, 10)}|${line.amountMinor}|${norm}`).digest('hex').slice(0, 32)}`;
}

export interface ImportResult {
  batch: string;
  imported: number;
  duplicates: number;
  from: string | null;
  to: string | null;
}

/** Insert lines, skipping any already present. One statement per call. */
export async function importStatementLines(db: LedgerDb, companyId: string, bankAccountId: string, lines: ParsedLine[]): Promise<ImportResult> {
  const bank = await getBankAccount(db, companyId, bankAccountId);
  if (!bank) throw new LedgerError(`bank account ${bankAccountId} not found for company ${companyId}`, 'invalid');
  if (lines.length > 5000) throw new LedgerError('at most 5000 lines per import', 'invalid');
  const batch = newId();
  let imported = 0;
  let duplicates = 0;
  for (const l of lines) {
    const r = await db.sql.execute(
      `INSERT INTO ${table(db, 'statement_lines')}
         (id, company_id, bank_account_id, posted_at, amount_minor, description, payee, reference, external_id, balance_after_minor, dedupe_key, import_batch)
       VALUES (gen_random_uuid(), $1, $2::uuid, $3::timestamptz, $4::bigint, $5, $6, $7, $8, $9::bigint, $10, $11)
       ON CONFLICT (bank_account_id, dedupe_key) DO NOTHING`,
      [companyId, bankAccountId, toIso(l.postedAt), fromMinor(l.amountMinor), l.description.slice(0, 500), l.payee?.slice(0, 200) ?? null, l.reference?.slice(0, 200) ?? null,
        l.externalId?.slice(0, 200) ?? null, l.balanceAfterMinor === undefined ? null : fromMinor(l.balanceAfterMinor), dedupeKey(l), batch],
    );
    if (r.rowCount === 1) imported += 1;
    else duplicates += 1;
  }
  const dates = lines.map((l) => l.postedAt.slice(0, 10)).sort();
  return { batch, imported, duplicates, from: dates[0] ?? null, to: dates[dates.length - 1] ?? null };
}

interface LineRow {
  id: string; company_id: string; bank_account_id: string; posted_at: string; amount_minor: unknown; description: string; payee: string | null; reference: string | null;
  external_id: string | null; balance_after_minor: unknown; status: LineStatus; reconciled_transaction_id: string | null; reconciled_at: string | null; reconciled_by: string | null;
  proposal: unknown; proposed_at: string | null; import_batch: string | null;
}

const LINE_SELECT = (db: LedgerDb) => `
  SELECT id, company_id, bank_account_id, posted_at::text AS posted_at, amount_minor, description, payee, reference, external_id, balance_after_minor, status,
         reconciled_transaction_id, reconciled_at::text AS reconciled_at, reconciled_by, proposal, proposed_at::text AS proposed_at, import_batch
    FROM ${table(db, 'statement_lines')}`;

function lineFromRow(r: LineRow): StatementLine {
  let proposal: Proposal | null = null;
  if (r.proposal) {
    try { proposal = typeof r.proposal === 'string' ? (JSON.parse(r.proposal) as Proposal) : (r.proposal as Proposal); } catch { proposal = null; }
  }
  return {
    id: r.id, companyId: r.company_id, bankAccountId: r.bank_account_id, postedAt: r.posted_at, amountMinor: fromMinor(toMinor(r.amount_minor)), description: r.description,
    payee: r.payee, reference: r.reference, externalId: r.external_id,
    balanceAfterMinor: r.balance_after_minor === null || r.balance_after_minor === undefined ? null : fromMinor(toMinor(r.balance_after_minor)),
    status: r.status, reconciledTransactionId: r.reconciled_transaction_id, reconciledAt: r.reconciled_at, reconciledBy: r.reconciled_by,
    proposal, proposedAt: r.proposed_at, importBatch: r.import_batch,
  };
}

export async function listStatementLines(
  db: LedgerDb,
  companyId: string,
  bankAccountId: string,
  opts: { status?: LineStatus | 'all'; limit?: number } = {},
): Promise<StatementLine[]> {
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 200), 1), 2000);
  const status = opts.status && opts.status !== 'all' ? opts.status : null;
  const rows = await db.sql.query<LineRow>(
    `${LINE_SELECT(db)} WHERE company_id = $1 AND bank_account_id = $2::uuid AND ($3::text IS NULL OR status = $3::text)
      ORDER BY posted_at DESC, created_at DESC LIMIT $4::int`,
    [companyId, bankAccountId, status, limit],
  );
  return rows.map(lineFromRow);
}

export async function getStatementLine(db: LedgerDb, companyId: string, lineId: string): Promise<StatementLine | null> {
  const rows = await db.sql.query<LineRow>(`${LINE_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, lineId]);
  return rows[0] ? lineFromRow(rows[0]) : null;
}

export async function saveProposal(db: LedgerDb, companyId: string, lineId: string, proposal: Proposal | null): Promise<void> {
  await db.sql.execute(
    `UPDATE ${table(db, 'statement_lines')} SET proposal = $3::jsonb, proposed_at = now() WHERE company_id = $1 AND id = $2::uuid AND status = 'unreconciled'`,
    [companyId, lineId, proposal ? JSON.stringify(proposal) : null],
  );
}

export async function markLine(
  db: LedgerDb,
  companyId: string,
  lineId: string,
  status: Exclude<LineStatus, 'unreconciled'>,
  transactionId: string | null,
  by: string,
): Promise<void> {
  await db.sql.execute(
    `UPDATE ${table(db, 'statement_lines')} SET status = $3, reconciled_transaction_id = $4::uuid, reconciled_at = now(), reconciled_by = $5
      WHERE company_id = $1 AND id = $2::uuid AND status = 'unreconciled'`,
    [companyId, lineId, status, transactionId, by],
  );
}

export async function linkTransactions(db: LedgerDb, companyId: string, lineId: string, transactionIds: string[]): Promise<void> {
  for (const t of transactionIds) {
    await db.sql.execute(
      `INSERT INTO ${table(db, 'reconciliation_links')} (id, company_id, line_id, transaction_id) VALUES (gen_random_uuid(), $1, $2::uuid, $3::uuid) ON CONFLICT (transaction_id) DO NOTHING`,
      [companyId, lineId, t],
    );
  }
}

/** Signed helper: money in is positive. */
export function lineAmount(line: StatementLine): Minor {
  return toMinor(line.amountMinor);
}
