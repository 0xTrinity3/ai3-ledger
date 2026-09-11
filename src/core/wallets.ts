/**
 * Company wallets, chain cursors and disputes: the rows only. Keys, chains
 * and venues live in the plugin layer; the core stays free of them.
 *
 * A wallet's private key is stored as given. Testnet money only, for now: a
 * mainnet wallet needs custody the company controls (a Safe with a policy
 * module), not a column in a table.
 */
import { LedgerError } from './ledger.js';
import { newId, table, type LedgerDb } from './sql.js';

export interface CompanyWallet {
  companyId: string;
  network: string;
  address: string;
  privateKey: string;
  bankAccountId: string | null;
  paymentMethodId: string | null;
  createdAt: string;
}

interface WalletRow { company_id: string; network: string; address: string; private_key: string; bank_account_id: string | null; payment_method_id: string | null; created_at: string }

function walletFromRow(r: WalletRow): CompanyWallet {
  return { companyId: r.company_id, network: r.network, address: r.address, privateKey: r.private_key, bankAccountId: r.bank_account_id, paymentMethodId: r.payment_method_id, createdAt: r.created_at };
}

export async function getWallet(db: LedgerDb, companyId: string): Promise<CompanyWallet | null> {
  const rows = await db.sql.query<WalletRow>(
    `SELECT company_id, network, address, private_key, bank_account_id, payment_method_id, created_at::text AS created_at FROM ${table(db, 'company_wallets')} WHERE company_id = $1`,
    [companyId],
  );
  return rows[0] ? walletFromRow(rows[0]) : null;
}

export async function saveWallet(db: LedgerDb, w: { companyId: string; network: string; address: string; privateKey: string; bankAccountId?: string | null; paymentMethodId?: string | null }): Promise<CompanyWallet> {
  await db.sql.execute(
    `INSERT INTO ${table(db, 'company_wallets')} (company_id, network, address, private_key, bank_account_id, payment_method_id)
     VALUES ($1, $2, $3, $4, $5::uuid, $6::uuid)
     ON CONFLICT (company_id) DO UPDATE SET bank_account_id = COALESCE(EXCLUDED.bank_account_id, ${table(db, 'company_wallets')}.bank_account_id), payment_method_id = COALESCE(EXCLUDED.payment_method_id, ${table(db, 'company_wallets')}.payment_method_id)`,
    [w.companyId, w.network, w.address, w.privateKey, w.bankAccountId ?? null, w.paymentMethodId ?? null],
  );
  const saved = await getWallet(db, w.companyId);
  if (!saved) throw new LedgerError('wallet was not written', 'invalid');
  return saved;
}

export async function getChainCursor(db: LedgerDb, bankAccountId: string): Promise<bigint> {
  const rows = await db.sql.query<{ last_block: string }>(`SELECT last_block::text AS last_block FROM ${table(db, 'chain_cursors')} WHERE bank_account_id = $1::uuid`, [bankAccountId]);
  return rows[0] ? BigInt(rows[0].last_block) : 0n;
}

export async function setChainCursor(db: LedgerDb, bankAccountId: string, lastBlock: bigint): Promise<void> {
  await db.sql.execute(
    `INSERT INTO ${table(db, 'chain_cursors')} (bank_account_id, last_block) VALUES ($1::uuid, $2::bigint)
     ON CONFLICT (bank_account_id) DO UPDATE SET last_block = EXCLUDED.last_block, updated_at = now()`,
    [bankAccountId, lastBlock.toString()],
  );
}

// ---------------------------------------------------------------------------
// Disputes
// ---------------------------------------------------------------------------

export type DisputeRole = 'claimant' | 'respondent';

export interface Dispute {
  id: string;
  companyId: string;
  invoiceId: string | null;
  invoiceNumber: string | null;
  invoiceUrl: string | null;
  role: DisputeRole;
  caseId: string | null;
  venue: string;
  status: string;
  amountMinor: string;
  currency: string;
  claim: string;
  ruling: unknown;
  instruction: unknown;
  settledTx: string | null;
  filedBy: string | null;
  filedAt: string;
  updatedAt: string;
}

interface DisputeRow { id: string; company_id: string; invoice_id: string | null; invoice_number: string | null; invoice_url: string | null; role: DisputeRole; case_id: string | null; venue: string; status: string; amount_minor: string; currency: string; claim: string; ruling: unknown; instruction: unknown; settled_tx: string | null; filed_by: string | null; filed_at: string; updated_at: string }

const parseJson = (v: unknown): unknown => (typeof v === 'string' ? (() => { try { return JSON.parse(v); } catch { return null; } })() : v ?? null);

function disputeFromRow(r: DisputeRow): Dispute {
  return { id: r.id, companyId: r.company_id, invoiceId: r.invoice_id, invoiceNumber: r.invoice_number, invoiceUrl: r.invoice_url, role: r.role, caseId: r.case_id, venue: r.venue, status: r.status, amountMinor: String(r.amount_minor), currency: r.currency, claim: r.claim, ruling: parseJson(r.ruling), instruction: parseJson(r.instruction), settledTx: r.settled_tx, filedBy: r.filed_by, filedAt: r.filed_at, updatedAt: r.updated_at };
}

const DISPUTE_SELECT = (db: LedgerDb) => `SELECT id, company_id, invoice_id, invoice_number, invoice_url, role, case_id, venue, status, amount_minor::text AS amount_minor, currency, claim, ruling, instruction, settled_tx, filed_by, filed_at::text AS filed_at, updated_at::text AS updated_at FROM ${table(db, 'disputes')}`;

export async function createDispute(db: LedgerDb, input: { companyId: string; invoiceId?: string | null; invoiceNumber?: string | null; invoiceUrl?: string | null; role: DisputeRole; caseId?: string | null; status?: string; amountMinor: bigint; currency: string; claim: string; ruling?: unknown; instruction?: unknown; filedBy?: string | null }): Promise<Dispute> {
  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'disputes')} (id, company_id, invoice_id, invoice_number, invoice_url, role, case_id, status, amount_minor, currency, claim, ruling, instruction, filed_by)
     VALUES ($1::uuid, $2, $3::uuid, $4, $5, $6, $7, $8, $9::bigint, $10, $11, $12::jsonb, $13::jsonb, $14)`,
    [id, input.companyId, input.invoiceId ?? null, input.invoiceNumber ?? null, input.invoiceUrl ?? null, input.role, input.caseId ?? null, input.status ?? 'filed', input.amountMinor.toString(), input.currency, input.claim.slice(0, 4000), input.ruling === undefined ? null : JSON.stringify(input.ruling), input.instruction === undefined ? null : JSON.stringify(input.instruction), input.filedBy ?? null],
  );
  const rows = await db.sql.query<DisputeRow>(`${DISPUTE_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [input.companyId, id]);
  return disputeFromRow(rows[0]!);
}

export async function updateDispute(db: LedgerDb, companyId: string, id: string, patch: { caseId?: string | null; status?: string; ruling?: unknown; instruction?: unknown; settledTx?: string | null }): Promise<Dispute> {
  const rows = await db.sql.query<DisputeRow>(`${DISPUTE_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  const cur = rows[0] ? disputeFromRow(rows[0]) : null;
  if (!cur) throw new LedgerError('dispute not found', 'invalid');
  await db.sql.execute(
    `UPDATE ${table(db, 'disputes')} SET case_id = $3, status = $4, ruling = $5::jsonb, instruction = $6::jsonb, settled_tx = $7, updated_at = now() WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, patch.caseId === undefined ? cur.caseId : patch.caseId, patch.status ?? cur.status, JSON.stringify(patch.ruling === undefined ? cur.ruling : patch.ruling), JSON.stringify(patch.instruction === undefined ? cur.instruction : patch.instruction), patch.settledTx === undefined ? cur.settledTx : patch.settledTx],
  );
  const after = await db.sql.query<DisputeRow>(`${DISPUTE_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return disputeFromRow(after[0]!);
}

export async function listDisputes(db: LedgerDb, companyId: string): Promise<Dispute[]> {
  const rows = await db.sql.query<DisputeRow>(`${DISPUTE_SELECT(db)} WHERE company_id = $1 ORDER BY filed_at DESC LIMIT 200`, [companyId]);
  return rows.map(disputeFromRow);
}

export async function getDispute(db: LedgerDb, companyId: string, idOrCase: string): Promise<Dispute | null> {
  const rows = await db.sql.query<DisputeRow>(`${DISPUTE_SELECT(db)} WHERE company_id = $1 AND (id::text = $2 OR case_id = $2) LIMIT 1`, [companyId, idOrCase]);
  return rows[0] ? disputeFromRow(rows[0]) : null;
}
