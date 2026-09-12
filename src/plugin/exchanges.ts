/**
 * Exchange accounts read with an API key: Coinbase, Kraken, Binance.
 *
 * One interface, three small clients, no SDK. Read-only by design: the ledger
 * never calls a trade or withdrawal endpoint, and where an exchange can say
 * whether a key may withdraw (Binance), a key that can is refused. An account
 * is one exchange and one currency, so it fits a bank account exactly; the
 * feed is the exchange's own ledger for that currency (deposits, withdrawals,
 * trades and fees on Coinbase and Kraken; deposits and withdrawals on
 * Binance, whose per-symbol trade history is not one ledger).
 */
import { createHash, createHmac, createPrivateKey, randomBytes, sign as cryptoSign } from 'node:crypto';
import { LedgerError, type ParsedLine } from '../core/index.js';

export type ExchangeId = 'coinbase' | 'kraken' | 'binance';
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ExchangeCredentials { apiKey: string; secret: string; passphrase?: string }

export interface ExchangeEntry {
  id: string;
  at: string;
  /** signed, in the account currency, cents */
  amountMinor: bigint;
  type: string;
  description: string;
  reference: string | null;
}

export interface ExchangeClient {
  id: ExchangeId;
  name: string;
  /** what the key form asks for */
  fields: Array<{ key: keyof ExchangeCredentials; label: string; secret: boolean; help?: string }>;
  /** currencies the feed can read as a single-currency bank account */
  currencies: string[];
  /** prove the key works and is not able to move money, where that can be known */
  validate(fetch: FetchLike, creds: ExchangeCredentials): Promise<{ ok: true; detail: string } | { ok: false; detail: string }>;
  /** every entry for the currency since a moment, oldest first */
  entries(fetch: FetchLike, creds: ExchangeCredentials, currency: string, since: string): Promise<ExchangeEntry[]>;
}

export const EXCHANGE_NOTE: Record<ExchangeId, string> = {
  coinbase: 'Create the key in Coinbase Developer Platform with View permission only. Paste the key name and its private key.',
  kraken: 'Create the key under Settings › API with Query Funds and Query Ledger Entries only. No trading, no withdrawals.',
  binance: 'Create the key under API Management with Enable Reading only. A key that can withdraw is refused.',
};

// ---------------------------------------------------------------------------
// Money helpers
// ---------------------------------------------------------------------------

/** "12.345678" → 1235 cents. Half a cent rounds away from zero; the feed loses nothing a person would reconcile. */
export function decimalToCents(v: string | number): bigint {
  const s = String(v).trim();
  if (!/^-?\d*(\.\d+)?$/.test(s) || s === '' || s === '-') throw new LedgerError(`not a decimal amount: ${s}`, 'invalid');
  const neg = s.startsWith('-');
  const [whole = '0', frac = ''] = s.replace('-', '').split('.');
  const f3 = (frac + '000').slice(0, 3);
  let cents = BigInt(whole || '0') * 100n + BigInt(f3.slice(0, 2));
  if (Number(f3[2]) >= 5) cents += 1n;
  return neg ? -cents : cents;
}

function iso(v: string | number | Date): string {
  const d = typeof v === 'number' ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  return Number.isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

async function readJson(r: Response): Promise<unknown> {
  const text = await r.text().catch(() => '');
  try { return text ? JSON.parse(text) : null; } catch { return { raw: text.slice(0, 200) }; }
}

function errorText(data: unknown, status: number): string {
  if (data && typeof data === 'object') {
    const d = data as Record<string, unknown>;
    if (typeof d['message'] === 'string') return d['message'];
    if (typeof d['msg'] === 'string') return d['msg'];
    if (Array.isArray(d['errors']) && d['errors'][0] && typeof (d['errors'][0] as { message?: unknown }).message === 'string') return (d['errors'][0] as { message: string }).message;
    if (Array.isArray(d['error']) && typeof d['error'][0] === 'string') return d['error'][0];
  }
  return `HTTP ${status}`;
}

// ---------------------------------------------------------------------------
// Coinbase: CDP API keys, JWT per request (ES256 for EC keys, EdDSA for Ed25519 keys)
// ---------------------------------------------------------------------------

const COINBASE_HOST = 'api.coinbase.com';

function b64url(b: Buffer | string): string {
  return Buffer.from(b).toString('base64').replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** A JWT Coinbase accepts for one request. Exported for the tests, which check its shape and signature. */
export function coinbaseJwt(creds: ExchangeCredentials, method: string, path: string, now = Math.floor(Date.now() / 1000)): string {
  const secret = creds.secret.trim();
  const pem = /-----BEGIN/.test(secret);
  const alg = pem ? 'ES256' : 'EdDSA';
  const header = { alg, kid: creds.apiKey.trim(), typ: 'JWT', nonce: randomBytes(16).toString('hex') };
  const payload = { sub: creds.apiKey.trim(), iss: 'cdp', nbf: now, exp: now + 120, uri: `${method} ${COINBASE_HOST}${path}` };
  const signing = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  let signature: Buffer;
  if (pem) {
    signature = cryptoSign('sha256', Buffer.from(signing), { key: secret.replace(/\\n/g, '\n'), dsaEncoding: 'ieee-p1363' });
  } else {
    const raw = Buffer.from(secret, 'base64');
    if (raw.length !== 64 && raw.length !== 32) throw new LedgerError('the Coinbase secret must be an EC private key (PEM) or a base64 Ed25519 key', 'invalid');
    const seed = raw.subarray(0, 32);
    const key = createPrivateKey({ key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]), format: 'der', type: 'pkcs8' });
    signature = cryptoSign(null, Buffer.from(signing), key);
  }
  return `${signing}.${b64url(signature)}`;
}

async function coinbaseGet(fetch: FetchLike, creds: ExchangeCredentials, pathWithQuery: string): Promise<unknown> {
  const path = pathWithQuery.split('?')[0]!;
  const jwt = coinbaseJwt(creds, 'GET', path);
  const r = await fetch(`https://${COINBASE_HOST}${pathWithQuery}`, { headers: { authorization: `Bearer ${jwt}`, accept: 'application/json', 'user-agent': 'ai3-ledger' } });
  const data = await readJson(r);
  if (!r.ok) throw new LedgerError(`Coinbase: ${errorText(data, r.status)}`, 'invalid');
  return data;
}

interface CoinbaseAccount { id: string; currency?: { code?: string } | string; balance?: { amount?: string; currency?: string } }
interface CoinbaseTx { id: string; type?: string; status?: string; amount?: { amount?: string; currency?: string }; description?: string | null; created_at?: string; details?: { title?: string; subtitle?: string }; network?: { hash?: string } }

async function coinbaseAccounts(fetch: FetchLike, creds: ExchangeCredentials): Promise<CoinbaseAccount[]> {
  const out: CoinbaseAccount[] = [];
  let next: string | null = '/v2/accounts?limit=100';
  for (let i = 0; next && i < 20; i++) {
    const page = (await coinbaseGet(fetch, creds, next)) as { data?: CoinbaseAccount[]; pagination?: { next_uri?: string | null } };
    out.push(...(page.data ?? []));
    next = page.pagination?.next_uri ?? null;
  }
  return out;
}

const coinbase: ExchangeClient = {
  id: 'coinbase',
  name: 'Coinbase',
  fields: [
    { key: 'apiKey', label: 'API key name', secret: false, help: 'organizations/…/apiKeys/…' },
    { key: 'secret', label: 'Private key', secret: true, help: 'The EC private key (PEM) or Ed25519 secret the key came with' },
  ],
  currencies: ['USD', 'USDC', 'EUR', 'GBP'],
  async validate(fetch, creds) {
    try {
      const accounts = await coinbaseAccounts(fetch, creds);
      return { ok: true, detail: `${accounts.length} account(s) visible` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
  async entries(fetch, creds, currency, since) {
    const want = currency.toUpperCase();
    const accounts = (await coinbaseAccounts(fetch, creds)).filter((a) => (typeof a.currency === 'string' ? a.currency : a.currency?.code ?? '').toUpperCase() === want);
    const out: ExchangeEntry[] = [];
    for (const a of accounts) {
      let next: string | null = `/v2/accounts/${encodeURIComponent(a.id)}/transactions?limit=100`;
      let stop = false;
      for (let i = 0; next && !stop && i < 50; i++) {
        const page = (await coinbaseGet(fetch, creds, next)) as { data?: CoinbaseTx[]; pagination?: { next_uri?: string | null } };
        for (const t of page.data ?? []) {
          const at = iso(t.created_at ?? Date.now());
          if (at < since) { stop = true; break; }
          if (t.status && t.status !== 'completed') continue;
          const amount = t.amount?.amount;
          if (amount === undefined) continue;
          const title = t.details?.title ?? t.type ?? 'transaction';
          const sub = t.details?.subtitle ?? t.description ?? '';
          out.push({ id: t.id, at, amountMinor: decimalToCents(amount), type: t.type ?? 'transaction', description: `Coinbase ${title}${sub ? ` · ${sub}` : ''}`, reference: t.network?.hash ?? null });
        }
        next = page.pagination?.next_uri ?? null;
      }
    }
    return out.sort((x, y) => x.at.localeCompare(y.at));
  },
};

// ---------------------------------------------------------------------------
// Kraken: HMAC-SHA512 over the path and the hashed nonce+body
// ---------------------------------------------------------------------------

const KRAKEN_HOST = 'https://api.kraken.com';
const KRAKEN_ASSET: Record<string, string> = { USD: 'ZUSD', EUR: 'ZEUR', GBP: 'ZGBP', CAD: 'ZCAD', JPY: 'ZJPY', AUD: 'ZAUD', BTC: 'XXBT', ETH: 'XETH' };

/** The API-Sign header. Exported for the tests, which check it against the documented construction. */
export function krakenSign(path: string, nonce: string, postData: string, secretB64: string): string {
  const sha = createHash('sha256').update(nonce + postData).digest();
  return createHmac('sha512', Buffer.from(secretB64, 'base64')).update(Buffer.concat([Buffer.from(path), sha])).digest('base64');
}

async function krakenPost(fetch: FetchLike, creds: ExchangeCredentials, path: string, params: Record<string, string>): Promise<Record<string, unknown>> {
  const nonce = String(Date.now() * 1000);
  const body = new URLSearchParams({ nonce, ...params }).toString();
  const r = await fetch(`${KRAKEN_HOST}${path}`, { method: 'POST', headers: { 'API-Key': creds.apiKey.trim(), 'API-Sign': krakenSign(path, nonce, body, creds.secret.trim()), 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'ai3-ledger' }, body });
  const data = (await readJson(r)) as { error?: string[]; result?: Record<string, unknown> } | null;
  if (!r.ok || (data?.error && data.error.length > 0)) throw new LedgerError(`Kraken: ${errorText(data, r.status)}`, 'invalid');
  return data?.result ?? {};
}

function krakenAssetMatches(code: string, want: string): boolean {
  const w = want.toUpperCase();
  const c = code.toUpperCase();
  return c === w || c === (KRAKEN_ASSET[w] ?? '') || c === `Z${w}` || c === `X${w}`;
}

interface KrakenLedger { refid?: string; time?: number; type?: string; subtype?: string; asset?: string; amount?: string; fee?: string; balance?: string }

const kraken: ExchangeClient = {
  id: 'kraken',
  name: 'Kraken',
  fields: [
    { key: 'apiKey', label: 'API key', secret: false },
    { key: 'secret', label: 'Private key', secret: true },
  ],
  currencies: ['USD', 'USDC', 'USDT', 'EUR', 'GBP'],
  async validate(fetch, creds) {
    try {
      const bal = await krakenPost(fetch, creds, '/0/private/Balance', {});
      return { ok: true, detail: `${Object.keys(bal).length} balance(s) visible` };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
  async entries(fetch, creds, currency, since) {
    const want = currency.toUpperCase();
    const asset = KRAKEN_ASSET[want] ?? want;
    const start = String(Math.floor(new Date(since).getTime() / 1000));
    const out: ExchangeEntry[] = [];
    for (let ofs = 0; ofs < 5000; ofs += 50) {
      const res = await krakenPost(fetch, creds, '/0/private/Ledgers', { asset, start, ofs: String(ofs) });
      const ledger = (res['ledger'] ?? {}) as Record<string, KrakenLedger>;
      const ids = Object.keys(ledger);
      for (const id of ids) {
        const e = ledger[id]!;
        if (!e.asset || !krakenAssetMatches(e.asset, want)) continue;
        const net = decimalToCents(e.amount ?? '0') - decimalToCents(e.fee ?? '0');
        out.push({ id, at: iso(e.time ?? Date.now()), amountMinor: net, type: e.type ?? 'ledger', description: `Kraken ${e.type ?? 'entry'}${e.subtype ? ` (${e.subtype})` : ''}${e.fee && Number(e.fee) ? ` · fee ${e.fee}` : ''}`, reference: e.refid ?? null });
      }
      if (ids.length < 50) break;
    }
    return out.sort((x, y) => x.at.localeCompare(y.at));
  },
};

// ---------------------------------------------------------------------------
// Binance: HMAC-SHA256 over the query string
// ---------------------------------------------------------------------------

const BINANCE_HOST = 'https://api.binance.com';

/** The signed query string. Exported for the tests. */
export function binanceQuery(params: Record<string, string>, secret: string): string {
  const q = new URLSearchParams(params).toString();
  return `${q}&signature=${createHmac('sha256', secret.trim()).update(q).digest('hex')}`;
}

async function binanceGet(fetch: FetchLike, creds: ExchangeCredentials, path: string, params: Record<string, string>): Promise<unknown> {
  const q = binanceQuery({ ...params, timestamp: String(Date.now()), recvWindow: '10000' }, creds.secret);
  const r = await fetch(`${BINANCE_HOST}${path}?${q}`, { headers: { 'X-MBX-APIKEY': creds.apiKey.trim(), 'user-agent': 'ai3-ledger' } });
  const data = await readJson(r);
  if (!r.ok) throw new LedgerError(`Binance: ${errorText(data, r.status)}`, 'invalid');
  return data;
}

interface BinanceDeposit { id?: string; txId?: string; amount?: string; coin?: string; status?: number; insertTime?: number; address?: string; network?: string }
interface BinanceWithdrawal { id?: string; txId?: string; amount?: string; transactionFee?: string; coin?: string; status?: number; applyTime?: string; completeTime?: string; address?: string; network?: string }

const NINETY_DAYS = 90 * 86_400_000;

const binance: ExchangeClient = {
  id: 'binance',
  name: 'Binance',
  fields: [
    { key: 'apiKey', label: 'API key', secret: false },
    { key: 'secret', label: 'Secret key', secret: true },
  ],
  currencies: ['USDC', 'USDT', 'EUR', 'GBP'],
  async validate(fetch, creds) {
    try {
      const r = (await binanceGet(fetch, creds, '/sapi/v1/account/apiRestrictions', {})) as { enableWithdrawals?: boolean; enableReading?: boolean };
      if (r.enableWithdrawals) return { ok: false, detail: 'this key can withdraw; make a read-only key' };
      if (r.enableReading === false) return { ok: false, detail: 'this key cannot read the account' };
      return { ok: true, detail: 'read-only key' };
    } catch (err) {
      return { ok: false, detail: err instanceof Error ? err.message : String(err) };
    }
  },
  async entries(fetch, creds, currency, since) {
    const coin = currency.toUpperCase();
    const out: ExchangeEntry[] = [];
    const end = Date.now();
    for (let from = new Date(since).getTime(); from < end; from += NINETY_DAYS) {
      const window = { coin, startTime: String(from), endTime: String(Math.min(from + NINETY_DAYS - 1, end)) };
      const deposits = (await binanceGet(fetch, creds, '/sapi/v1/capital/deposit/hisrec', window)) as BinanceDeposit[];
      for (const d of Array.isArray(deposits) ? deposits : []) {
        if (d.status !== 1 || d.amount === undefined) continue;
        out.push({ id: `dep:${d.id ?? d.txId ?? `${d.insertTime}`}`, at: iso(d.insertTime ?? end), amountMinor: decimalToCents(d.amount), type: 'deposit', description: `Binance deposit${d.network ? ` via ${d.network}` : ''}${d.address ? ` to ${d.address}` : ''}`, reference: d.txId ?? null });
      }
      const withdrawals = (await binanceGet(fetch, creds, '/sapi/v1/capital/withdraw/history', window)) as BinanceWithdrawal[];
      for (const w of Array.isArray(withdrawals) ? withdrawals : []) {
        if (w.status !== 6 || w.amount === undefined) continue;
        const net = decimalToCents(w.amount) + decimalToCents(w.transactionFee ?? '0');
        out.push({ id: `wd:${w.id ?? w.txId ?? w.applyTime}`, at: iso(w.completeTime ?? w.applyTime ?? end), amountMinor: -net, type: 'withdrawal', description: `Binance withdrawal${w.network ? ` via ${w.network}` : ''}${w.address ? ` to ${w.address}` : ''}${w.transactionFee && Number(w.transactionFee) ? ` · fee ${w.transactionFee}` : ''}`, reference: w.txId ?? null });
      }
    }
    return out.sort((x, y) => x.at.localeCompare(y.at));
  },
};

export const EXCHANGES: Record<ExchangeId, ExchangeClient> = { coinbase, kraken, binance };

export function exchangeOf(id: string | null | undefined): ExchangeClient | null {
  return id && (id as ExchangeId) in EXCHANGES ? EXCHANGES[id as ExchangeId] : null;
}

/** What the plugin UI shows for the key forms. */
export function exchangeSummaries() {
  return Object.values(EXCHANGES).map((e) => ({ id: e.id, name: e.name, fields: e.fields, currencies: e.currencies, note: EXCHANGE_NOTE[e.id] }));
}

/** Exchange entries as statement lines for the account's bank account. */
export function linesFromEntries(exchange: ExchangeId, entries: ExchangeEntry[]): ParsedLine[] {
  return entries.filter((e) => e.amountMinor !== 0n).map((e) => ({
    postedAt: e.at,
    amountMinor: e.amountMinor,
    description: e.description.slice(0, 500),
    payee: EXCHANGES[exchange].name,
    reference: e.reference ?? e.id,
    externalId: `${exchange}:${e.id}`,
  }));
}
