/**
 * Bank feeds, through ai3.co. The other half of what ai3.co's Plaid and
 * GoCardless adapters fetch.
 *
 * ai3.co holds one app per aggregator and the owner's own authorisation with
 * their bank; the tenant asks for its lines with its company key and never
 * learns whose credentials answered, exactly as it already does for Stripe.
 * Signs are normalised there (Plaid calls money leaving the account positive;
 * GoCardless signs like a statement), so what arrives here is already the
 * ledger's convention: money in positive, money out negative.
 *
 * A provider account becomes a bank account under Treasury on first sight,
 * keyed by `bank:<provider>:<account>` in `external_ref` so a second sync
 * never makes a second account, and the ledger's id is sent back to ai3.co so
 * the cursor and the account live together on the side that holds the feed.
 *
 * One rule worth naming: a line is only imported when its currency matches
 * the bank account's. A multi-currency account (Wise, Revolut) returns lines
 * in currencies the ledger account cannot hold, and booking those at the
 * account's currency would quietly misstate the books. They are counted and
 * reported instead.
 */
import {
  createBankAccount,
  getBankAccount,
  importStatementLines,
  listBankAccounts,
  runReconciliation,
  type BankAccount,
  type CompanySettings,
  type LedgerDb,
  type ParsedLine,
} from '../core/index.js';
import { Ai3Error, ai3Call, isConnected, type FetchLike } from './ai3.js';

export type BankFeedProvider = 'plaid' | 'gocardless';

export interface BankRemoteAccount {
  id: string;
  name: string;
  kind: 'bank' | 'card';
  currency: string;
  cursor: string | null;
  bankAccountId: string | null;
}

export interface BankConnectionView {
  id: string;
  provider: BankFeedProvider;
  institution: string | null;
  institutionName: string | null;
  accounts: BankRemoteAccount[];
  connectedAt: string | null;
  lastSyncedAt: string | null;
  revokedAt: string | null;
  error: string | null;
}

export interface BankRemote {
  providers: { plaid: boolean; gocardless: boolean };
  connections: BankConnectionView[];
  /** The ai3.co page where the owner authorises a bank. The tenant cannot run that flow itself. */
  connectUrl: string | null;
}

/** One line as ai3.co sends it: already signed the ledger's way. */
export interface BankFeedLine {
  postedAt: string;
  amountMinor: string;
  description: string;
  payee?: string | null;
  reference?: string | null;
  externalId?: string | null;
  currency?: string | null;
}

export interface BankAccountSync {
  connectionId: string;
  accountId: string;
  bankAccountId: string;
  name: string;
  currency: string;
  imported: number;
  duplicates: number;
  otherCurrency: number;
  autoPosted: number;
  leftForReview: number;
  error: string | null;
  reconnect: boolean;
  /** True when the provider's rate limit says not yet. Nothing was asked for. */
  waited: boolean;
}

export interface BankSyncResult {
  connections: number;
  accounts: number;
  imported: number;
  duplicates: number;
  otherCurrency: number;
  autoPosted: number;
  leftForReview: number;
  needsReconnect: string[];
  waited: number;
  perAccount: BankAccountSync[];
}

const ACCOUNT_KIND = new Set(['bank', 'card']);

function asAccount(d: unknown): BankRemoteAccount | null {
  const a = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const id = typeof a['id'] === 'string' ? a['id'] : '';
  if (!id) return null;
  const kind = typeof a['kind'] === 'string' && ACCOUNT_KIND.has(a['kind']) ? (a['kind'] as 'bank' | 'card') : 'bank';
  return {
    id,
    name: typeof a['name'] === 'string' && a['name'].trim() ? a['name'].trim() : id,
    kind,
    currency: typeof a['currency'] === 'string' && a['currency'].length === 3 ? a['currency'].toUpperCase() : '',
    cursor: typeof a['cursor'] === 'string' ? a['cursor'] : null,
    bankAccountId: typeof a['bankAccountId'] === 'string' ? a['bankAccountId'] : null,
  };
}

function asConnection(d: unknown): BankConnectionView | null {
  const c = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const provider = c['provider'] === 'plaid' || c['provider'] === 'gocardless' ? (c['provider'] as BankFeedProvider) : null;
  if (!provider) return null;
  const accounts = (Array.isArray(c['accounts']) ? c['accounts'] : []).map(asAccount).filter((a): a is BankRemoteAccount => a !== null);
  const s = (k: string) => (typeof c[k] === 'string' ? (c[k] as string) : null);
  return {
    // ai3.co keys a connection `<provider>:<institution or first account>`; it
    // may be absent on an older record, and the provider alone still addresses it.
    id: s('id') ?? provider,
    provider,
    institution: s('institution'),
    institutionName: s('institutionName'),
    accounts,
    connectedAt: s('connectedAt'),
    lastSyncedAt: s('lastSyncedAt'),
    revokedAt: s('revokedAt'),
    error: s('error'),
  };
}

function asRemote(d: unknown): BankRemote {
  const r = (d && typeof d === 'object' ? d : {}) as Record<string, unknown>;
  const p = (r['providers'] && typeof r['providers'] === 'object' ? r['providers'] : {}) as Record<string, unknown>;
  return {
    providers: { plaid: p['plaid'] === true, gocardless: p['gocardless'] === true },
    connections: (Array.isArray(r['connections']) ? r['connections'] : []).map(asConnection).filter((c): c is BankConnectionView => c !== null),
    connectUrl: typeof r['connectUrl'] === 'string' ? r['connectUrl'] : null,
  };
}

/** Where a company's bank connections stand, as ai3.co sees them. */
export async function bankStatus(fetch: FetchLike, settings: CompanySettings, companyId: string): Promise<BankRemote> {
  return asRemote(await ai3Call(fetch, settings, '/api/ledger/bank/status', { companyId }));
}

export function externalRefFor(provider: BankFeedProvider, accountId: string): string {
  return `bank:${provider}:${accountId}`;
}

/** "Revolut Business · Main ••1234", or just the account when the bank is unnamed. */
export function bankAccountName(connection: BankConnectionView, account: BankRemoteAccount): string {
  const bank = (connection.institutionName || '').trim();
  const acct = (account.name || '').trim();
  if (bank && acct && !acct.toLowerCase().includes(bank.toLowerCase())) return `${bank} · ${acct}`.slice(0, 120);
  return (acct || bank || account.id).slice(0, 120);
}

export interface BankPair { connection: BankConnectionView; account: BankRemoteAccount; bank: BankAccount }

/**
 * Give every live provider account a bank account under Treasury and tell
 * ai3.co which one it is. Idempotent: `external_ref` is the identity, so a
 * failed link on one run is repaired on the next without a duplicate.
 * A revoked connection is left alone — its account stays, its feed does not.
 */
export async function ensureBankAccounts(
  db: LedgerDb,
  fetch: FetchLike,
  settings: CompanySettings,
  companyId: string,
  remote: BankRemote,
  baseCurrency: string,
): Promise<BankPair[]> {
  const existing = await listBankAccounts(db, companyId);
  const pairs: BankPair[] = [];
  for (const connection of remote.connections) {
    if (connection.revokedAt) continue;
    for (const account of connection.accounts) {
      const ref = externalRefFor(connection.provider, account.id);
      let bank = existing.find((b) => b.externalRef === ref)
        ?? (account.bankAccountId ? existing.find((b) => b.id === account.bankAccountId) : undefined);
      if (!bank) {
        bank = await createBankAccount(db, companyId, {
          name: bankAccountName(connection, account),
          kind: account.kind,
          currency: account.currency || baseCurrency,
          feed: 'aggregator',
          externalRef: ref,
        });
        existing.push(bank);
      }
      if (account.bankAccountId !== bank.id) {
        // ai3.co keeps the cursor beside the account, so it needs the ledger's id.
        try {
          await ai3Call(fetch, settings, '/api/ledger/bank/link', { companyId, connection: connection.id, account: account.id, bankAccountId: bank.id });
          account.bankAccountId = bank.id;
        } catch { /* the next sync tries again; nothing is duplicated meanwhile */ }
      }
      pairs.push({ connection, account, bank });
    }
  }
  return pairs;
}

/** ai3.co's lines as the matcher reads them, keeping only what this account can hold. */
export function linesFromBank(provider: BankFeedProvider, lines: BankFeedLine[], currency: string): { lines: ParsedLine[]; otherCurrency: number } {
  const want = String(currency || '').toUpperCase();
  let otherCurrency = 0;
  const out: ParsedLine[] = [];
  for (const l of lines) {
    if (!l || typeof l.postedAt !== 'string' || !/^-?\d+$/.test(String(l.amountMinor))) continue;
    const amount = BigInt(l.amountMinor);
    if (amount === 0n) continue;
    const lineCurrency = String(l.currency || want).toUpperCase();
    if (want && lineCurrency !== want) { otherCurrency += 1; continue; }
    out.push({
      postedAt: l.postedAt,
      amountMinor: amount,
      description: String(l.description || 'Transaction'),
      ...(l.payee ? { payee: String(l.payee) } : {}),
      ...(l.reference ? { reference: String(l.reference) } : {}),
      ...(l.externalId ? { externalId: `${provider}:${l.externalId}` } : {}),
    });
  }
  return { lines: out, otherCurrency };
}

/**
 * How often a provider may be asked. GoCardless caps a free account at ten
 * requests per endpoint per account per day, so a six-hour floor leaves room
 * for the owner's own manual syncs; Plaid has no such cap and only needs
 * enough spacing to be polite. Exceeding GoCardless's cap costs the company
 * its feed for the rest of the day, which is why this is a rule and not a
 * schedule.
 */
export const MIN_SYNC_MINUTES: Record<BankFeedProvider, number> = { gocardless: 6 * 60, plaid: 10 };

/** Whether a connection may be pulled now. `force` is a person asking. */
export function dueForSync(connection: BankConnectionView, opts: { force?: boolean; now?: Date } = {}): boolean {
  if (connection.revokedAt) return false;
  if (opts.force) return true;
  if (!connection.lastSyncedAt) return true;
  const last = Date.parse(connection.lastSyncedAt);
  if (!Number.isFinite(last)) return true;
  const minutes = ((opts.now ?? new Date()).getTime() - last) / 60_000;
  return minutes >= MIN_SYNC_MINUTES[connection.provider];
}

const MAX_PAGES = 10;

async function syncOneAccount(
  db: LedgerDb,
  fetch: FetchLike,
  settings: CompanySettings,
  companyId: string,
  pair: BankPair,
  opts: { autoPost?: boolean; by?: string; force?: boolean },
): Promise<BankAccountSync> {
  const by = opts.by ?? 'bank-feed';
  const base: BankAccountSync = {
    connectionId: pair.connection.id, accountId: pair.account.id, bankAccountId: pair.bank.id,
    name: pair.bank.name, currency: pair.bank.currency,
    imported: 0, duplicates: 0, otherCurrency: 0, autoPosted: 0, leftForReview: 0, error: null, reconnect: false, waited: false,
  };
  if (!dueForSync(pair.connection, { force: opts.force === true })) { base.waited = true; return base; }
  let cursor = pair.account.cursor;
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const r = (await ai3Call(fetch, settings, '/api/ledger/bank/transactions', {
        companyId, connection: pair.connection.id, account: pair.account.id, ...(cursor ? { cursor } : {}),
      })) as { lines?: BankFeedLine[]; cursor?: string | null };
      const raw = Array.isArray(r.lines) ? r.lines : [];
      if (raw.length > 0) {
        const { lines, otherCurrency } = linesFromBank(pair.connection.provider, raw, pair.bank.currency);
        base.otherCurrency += otherCurrency;
        if (lines.length > 0) {
          const res = await importStatementLines(db, companyId, pair.bank.id, lines);
          base.imported += res.imported;
          base.duplicates += res.duplicates;
        }
      }
      const next = typeof r.cursor === 'string' && r.cursor ? r.cursor : null;
      // Both adapters page internally; ai3.co answers with the cursor it
      // reached. Stop when it stops moving, so a provider that always returns
      // the same window cannot spin.
      if (!next || next === cursor || raw.length === 0) { cursor = next ?? cursor; break; }
      cursor = next;
    }
  } catch (err) {
    base.error = err instanceof Error ? err.message : String(err);
    base.reconnect = err instanceof Ai3Error && err.status === 409;
    return base;
  }
  if (base.imported > 0) {
    const run = await runReconciliation(db, companyId, pair.bank.id, { autoPost: opts.autoPost ?? true, by });
    base.autoPosted = run.autoPosted;
    base.leftForReview = run.leftForReview;
  }
  return base;
}

/**
 * Pull every live bank account's new lines and let the matcher post what it
 * is sure of. A failing account is reported, never thrown: one bank being
 * down must not stop the others, and a revoked authorisation is a thing the
 * owner has to do something about, not an error in the books.
 */
export async function syncBankFeeds(
  db: LedgerDb,
  fetch: FetchLike,
  settings: CompanySettings,
  companyId: string,
  opts: { autoPost?: boolean; by?: string; baseCurrency?: string; force?: boolean } = {},
): Promise<BankSyncResult | null> {
  if (!isConnected(settings)) return null;
  const remote = await bankStatus(fetch, settings, companyId);
  if (remote.connections.length === 0) return null;
  const pairs = await ensureBankAccounts(db, fetch, settings, companyId, remote, opts.baseCurrency ?? settings.baseCurrency);
  const perAccount: BankAccountSync[] = [];
  for (const pair of pairs) perAccount.push(await syncOneAccount(db, fetch, settings, companyId, pair, opts));
  const sum = (f: (a: BankAccountSync) => number) => perAccount.reduce((n, a) => n + f(a), 0);
  return {
    connections: remote.connections.filter((c) => !c.revokedAt).length,
    accounts: pairs.length,
    imported: sum((a) => a.imported),
    duplicates: sum((a) => a.duplicates),
    otherCurrency: sum((a) => a.otherCurrency),
    autoPosted: sum((a) => a.autoPosted),
    leftForReview: sum((a) => a.leftForReview),
    needsReconnect: perAccount.filter((a) => a.reconnect).map((a) => a.name),
    waited: perAccount.filter((a) => a.waited).length,
    perAccount,
  };
}

/** What the finance pages show: the connections, and the bank account each feeds. */
export async function bankFeedView(
  db: LedgerDb,
  fetch: FetchLike,
  settings: CompanySettings,
  companyId: string,
): Promise<{ ai3Connected: boolean; providers: BankRemote['providers'] | null; connectUrl: string | null; connections: BankConnectionView[]; accounts: Array<{ bankAccountId: string; name: string; currency: string; lastLineAt: string | null; unreconciled: number }>; error: string | null }> {
  if (!isConnected(settings)) return { ai3Connected: false, providers: null, connectUrl: null, connections: [], accounts: [], error: null };
  let remote: BankRemote = { providers: { plaid: false, gocardless: false }, connections: [], connectUrl: null };
  let error: string | null = null;
  try { remote = await bankStatus(fetch, settings, companyId); } catch (err) { error = err instanceof Error ? err.message : String(err); }
  const accounts: Array<{ bankAccountId: string; name: string; currency: string; lastLineAt: string | null; unreconciled: number }> = [];
  for (const c of remote.connections) {
    for (const a of c.accounts) {
      if (!a.bankAccountId) continue;
      const bank = await getBankAccount(db, companyId, a.bankAccountId);
      if (bank) accounts.push({ bankAccountId: bank.id, name: bank.name, currency: bank.currency, lastLineAt: bank.lastLineAt, unreconciled: bank.unreconciled });
    }
  }
  return { ai3Connected: true, providers: remote.providers, connectUrl: remote.connectUrl, connections: remote.connections, accounts, error };
}
