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

// ---------------------------------------------------------------------------
// Connected wallets: an address the company watches, or an exchange it reads
// ---------------------------------------------------------------------------

export type ConnectedWalletKind = 'address' | 'exchange';

export interface ConnectedWallet {
  id: string;
  companyId: string;
  kind: ConnectedWalletKind;
  label: string;
  /** chain slug for an address wallet (tempo-moderato, base, ethereum) */
  network: string | null;
  address: string | null;
  /** exchange id for an exchange account (coinbase, kraken, binance) */
  exchange: string | null;
  currency: string;
  hasCredentials: boolean;
  /** the ownership signature for an address wallet, when one was given */
  /**
   * How the company showed the address is theirs. A signed message is the
   * usual way. A credit top-up is the other: paying ai3.co from that address
   * is itself a transaction signed by it, so the transfer stands in for the
   * signature — `via` says which assurance this is, rather than implying a
   * local signature check that did not happen.
   */
  proof:
    | { message: string; signature: string; at: string }
    | { via: 'ai3-credit-top-up'; txHash: string; amountMinor: string; memo: string | null; at: string }
    | null;
  bankAccountId: string | null;
  cursor: Record<string, unknown> | null;
  lastSyncAt: string | null;
  lastError: string | null;
  createdBy: string | null;
  createdAt: string;
  archivedAt: string | null;
}

interface ConnectedRow {
  id: string; company_id: string; kind: ConnectedWalletKind; label: string; network: string | null; address: string | null; exchange: string | null; currency: string;
  has_credentials: boolean; proof: unknown; bank_account_id: string | null; cursor_json: unknown; last_sync_at: string | null; last_error: string | null; created_by: string | null; created_at: string; archived_at: string | null;
}

const CONNECTED_SELECT = (db: LedgerDb) => `SELECT id, company_id, kind, label, network, address, exchange, currency, (credentials IS NOT NULL) AS has_credentials, proof, bank_account_id, cursor_json,
  last_sync_at::text AS last_sync_at, last_error, created_by, created_at::text AS created_at, archived_at::text AS archived_at FROM ${table(db, 'connected_wallets')}`;

function connectedFromRow(r: ConnectedRow): ConnectedWallet {
  return {
    id: r.id, companyId: r.company_id, kind: r.kind, label: r.label, network: r.network, address: r.address, exchange: r.exchange, currency: r.currency,
    hasCredentials: r.has_credentials === true, proof: (parseJson(r.proof) as ConnectedWallet['proof']) ?? null, bankAccountId: r.bank_account_id,
    cursor: (parseJson(r.cursor_json) as Record<string, unknown> | null) ?? null, lastSyncAt: r.last_sync_at, lastError: r.last_error, createdBy: r.created_by, createdAt: r.created_at, archivedAt: r.archived_at,
  };
}

export const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export async function listConnectedWallets(db: LedgerDb, companyId: string, opts: { includeArchived?: boolean } = {}): Promise<ConnectedWallet[]> {
  const rows = await db.sql.query<ConnectedRow>(`${CONNECTED_SELECT(db)} WHERE company_id = $1 AND ($2::boolean OR archived_at IS NULL) ORDER BY created_at`, [companyId, opts.includeArchived === true]);
  return rows.map(connectedFromRow);
}

export async function getConnectedWallet(db: LedgerDb, companyId: string, id: string): Promise<ConnectedWallet | null> {
  const rows = await db.sql.query<ConnectedRow>(`${CONNECTED_SELECT(db)} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return rows[0] ? connectedFromRow(rows[0]) : null;
}

/** The connected wallet behind a bank account, if the account is one. */
export async function connectedWalletForBank(db: LedgerDb, companyId: string, bankAccountId: string): Promise<ConnectedWallet | null> {
  const rows = await db.sql.query<ConnectedRow>(`${CONNECTED_SELECT(db)} WHERE company_id = $1 AND bank_account_id = $2::uuid AND archived_at IS NULL LIMIT 1`, [companyId, bankAccountId]);
  return rows[0] ? connectedFromRow(rows[0]) : null;
}

/** The active address wallet on a network, matched case-insensitively. */
export async function findConnectedAddress(db: LedgerDb, companyId: string, network: string, address: string): Promise<ConnectedWallet | null> {
  const rows = await db.sql.query<ConnectedRow>(`${CONNECTED_SELECT(db)} WHERE company_id = $1 AND kind = 'address' AND network = $2 AND lower(address) = lower($3) AND archived_at IS NULL LIMIT 1`, [companyId, network, address]);
  return rows[0] ? connectedFromRow(rows[0]) : null;
}

export async function createConnectedWallet(
  db: LedgerDb,
  companyId: string,
  input: { kind: ConnectedWalletKind; label: string; network?: string | null; address?: string | null; exchange?: string | null; currency: string; credentials?: string | null; proof?: ConnectedWallet['proof']; bankAccountId?: string | null; cursor?: Record<string, unknown> | null; createdBy?: string | null },
): Promise<ConnectedWallet> {
  const label = String(input.label ?? '').trim();
  if (label.length < 1 || label.length > 120) throw new LedgerError('a wallet needs a label of 1 to 120 characters', 'invalid');
  if (input.kind === 'address') {
    if (!input.network) throw new LedgerError('an address wallet needs a network', 'invalid');
    if (!input.address || !EVM_ADDRESS.test(input.address)) throw new LedgerError('the address must be a 0x address of 40 hex characters', 'invalid');
    if (await findConnectedAddress(db, companyId, input.network, input.address)) throw new LedgerError('that address is already connected on this network', 'invalid');
  } else if (input.kind === 'exchange') {
    if (!input.exchange) throw new LedgerError('an exchange account needs the exchange', 'invalid');
    if (!input.credentials) throw new LedgerError('an exchange account needs credentials', 'invalid');
  } else {
    throw new LedgerError('kind must be address or exchange', 'invalid');
  }
  const id = newId();
  await db.sql.execute(
    `INSERT INTO ${table(db, 'connected_wallets')} (id, company_id, kind, label, network, address, exchange, currency, credentials, proof, bank_account_id, cursor_json, created_by)
     VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::uuid, $12::jsonb, $13)`,
    [id, companyId, input.kind, label, input.network ?? null, input.address ?? null, input.exchange ?? null, input.currency, input.credentials ?? null, input.proof ? JSON.stringify(input.proof) : null, input.bankAccountId ?? null, input.cursor ? JSON.stringify(input.cursor) : null, input.createdBy ?? null],
  );
  const w = await getConnectedWallet(db, companyId, id);
  if (!w) throw new LedgerError('wallet was not written', 'invalid');
  return w;
}

/** The sealed credentials of an exchange account. Only the plugin's vault unseals them. */
export async function readConnectedCredentials(db: LedgerDb, companyId: string, id: string): Promise<string | null> {
  const rows = await db.sql.query<{ credentials: string | null }>(`SELECT credentials FROM ${table(db, 'connected_wallets')} WHERE company_id = $1 AND id = $2::uuid`, [companyId, id]);
  return rows[0]?.credentials ?? null;
}

export async function setConnectedSync(db: LedgerDb, companyId: string, id: string, patch: { cursor?: Record<string, unknown> | null; lastError?: string | null }): Promise<void> {
  const cur = await getConnectedWallet(db, companyId, id);
  if (!cur) throw new LedgerError('wallet not found', 'invalid');
  await db.sql.execute(
    `UPDATE ${table(db, 'connected_wallets')} SET cursor_json = $3::jsonb, last_error = $4, last_sync_at = now() WHERE company_id = $1 AND id = $2::uuid`,
    [companyId, id, JSON.stringify(patch.cursor === undefined ? cur.cursor : patch.cursor), patch.lastError === undefined ? null : patch.lastError?.slice(0, 500) ?? null],
  );
}

/** Stop watching. The bank account and its lines stay in the books; the account is archived. */
export async function archiveConnectedWallet(db: LedgerDb, companyId: string, id: string): Promise<ConnectedWallet> {
  const cur = await getConnectedWallet(db, companyId, id);
  if (!cur) throw new LedgerError('wallet not found', 'invalid');
  await db.sql.execute(`UPDATE ${table(db, 'connected_wallets')} SET archived_at = now(), credentials = NULL WHERE company_id = $1 AND id = $2::uuid AND archived_at IS NULL`, [companyId, id]);
  if (cur.bankAccountId) await db.sql.execute(`UPDATE ${table(db, 'bank_accounts')} SET archived_at = now() WHERE company_id = $1 AND id = $2::uuid AND archived_at IS NULL`, [companyId, cur.bankAccountId]);
  return (await getConnectedWallet(db, companyId, id)) ?? cur;
}

// ---------------------------------------------------------------------------
// Vault key: one random key per plugin database, used to seal credentials
// ---------------------------------------------------------------------------

export async function getVaultKey(db: LedgerDb): Promise<string | null> {
  const rows = await db.sql.query<{ key_b64: string }>(`SELECT key_b64 FROM ${table(db, 'ledger_vault')} WHERE id = 1`, []);
  return rows[0]?.key_b64 ?? null;
}

export async function ensureVaultKey(db: LedgerDb, generate: () => string): Promise<string> {
  const have = await getVaultKey(db);
  if (have) return have;
  await db.sql.execute(`INSERT INTO ${table(db, 'ledger_vault')} (id, key_b64) VALUES (1, $1) ON CONFLICT (id) DO NOTHING`, [generate()]);
  const now = await getVaultKey(db);
  if (!now) throw new LedgerError('vault key was not written', 'invalid');
  return now;
}
