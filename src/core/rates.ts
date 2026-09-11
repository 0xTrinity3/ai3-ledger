/**
 * Exchange rates, from two free sources with no keys:
 *
 *  - Frankfurter (frankfurter.dev): the European Central Bank's daily
 *    reference rates for fiat currencies, with history by date.
 *  - CoinGecko's public API: stablecoins and crypto against fiat, current and
 *    by date.
 *
 * A quote says where it came from and for which day, and the person can still
 * overwrite the number. The fetch function is injected so the plugin can use
 * the host's outbound client and tests can use a fake.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface RateQuote {
  from: string;
  to: string;
  /** Units of `to` per one unit of `from`, up to ten decimals. */
  rate: string;
  /** The day the rate is for (YYYY-MM-DD). */
  date: string;
  source: string;
}

export class RateError extends Error {}

const CRYPTO_IDS: Record<string, string> = { USDC: 'usd-coin', USDT: 'tether', DAI: 'dai', ETH: 'ethereum', BTC: 'bitcoin', SOL: 'solana', MATIC: 'matic-network', ARB: 'arbitrum', OP: 'optimism' };
/** Stablecoins that track the dollar; used only when CoinGecko cannot be reached. */
const USD_PEGGED = new Set(['USDC', 'USDT', 'DAI']);
const COINGECKO_FIAT = new Set(['USD', 'EUR', 'GBP', 'CAD', 'AUD', 'CHF', 'SGD', 'JPY', 'NZD', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'HUF', 'INR', 'BRL', 'MXN', 'ZAR', 'HKD', 'KRW', 'TRY', 'AED', 'SAR', 'ILS']);

export function isCrypto(code: string): boolean {
  return code.toUpperCase() in CRYPTO_IDS;
}

function fmtRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) throw new RateError('rate is not a positive number');
  return n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '');
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

const cache = new Map<string, { quote: RateQuote; expires: number }>();

async function getJson(fetch: FetchLike, url: string): Promise<unknown> {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'ai3-ledger/0.7 (+https://ai3.co)' } });
  if (!r.ok) throw new RateError(`${new URL(url).host} answered ${r.status}`);
  return r.json();
}

async function fiatRate(fetch: FetchLike, from: string, to: string, date: string | undefined): Promise<RateQuote> {
  const day = date && date < todayIso() ? date : 'latest';
  const data = (await getJson(fetch, `https://api.frankfurter.dev/v1/${day}?base=${from}&symbols=${to}`)) as { date?: string; rates?: Record<string, number> };
  const rate = data.rates?.[to];
  if (typeof rate !== 'number') throw new RateError(`no ECB rate for ${from} to ${to}`);
  return { from, to, rate: fmtRate(rate), date: data.date ?? day, source: 'ECB reference rate via Frankfurter' };
}

async function cryptoToFiat(fetch: FetchLike, coin: string, fiat: string, date: string | undefined): Promise<{ rate: number; date: string }> {
  const id = CRYPTO_IDS[coin]!;
  const vs = fiat.toLowerCase();
  if (date && date < todayIso()) {
    const [y, m, d] = date.split('-');
    const data = (await getJson(fetch, `https://api.coingecko.com/api/v3/coins/${id}/history?date=${d}-${m}-${y}&localization=false`)) as { market_data?: { current_price?: Record<string, number> } };
    const rate = data.market_data?.current_price?.[vs];
    if (typeof rate !== 'number') throw new RateError(`no CoinGecko price for ${coin} in ${fiat} on ${date}`);
    return { rate, date };
  }
  const data = (await getJson(fetch, `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=${vs}`)) as Record<string, Record<string, number>>;
  const rate = data[id]?.[vs];
  if (typeof rate !== 'number') throw new RateError(`no CoinGecko price for ${coin} in ${fiat}`);
  return { rate, date: todayIso() };
}

/** Units of `to` per one `from`, for a day (default: the latest available). */
export async function getRate(fetch: FetchLike, fromRaw: string, toRaw: string, date?: string): Promise<RateQuote> {
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  if (from === to) return { from, to, rate: '1', date: date ?? todayIso(), source: 'same currency' };
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new RateError('date must be YYYY-MM-DD');
  const key = `${from}:${to}:${date ?? 'latest'}`;
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.quote;

  let quote: RateQuote;
  const fromCrypto = isCrypto(from);
  const toCrypto = isCrypto(to);
  if (!fromCrypto && !toCrypto) {
    quote = await fiatRate(fetch, from, to, date);
  } else if (fromCrypto && !toCrypto) {
    try {
      if (COINGECKO_FIAT.has(to)) {
        const r = await cryptoToFiat(fetch, from, to, date);
        quote = { from, to, rate: fmtRate(r.rate), date: r.date, source: 'CoinGecko' };
      } else {
        const usd = await cryptoToFiat(fetch, from, 'USD', date);
        const leg = await fiatRate(fetch, 'USD', to, date);
        quote = { from, to, rate: fmtRate(usd.rate * Number(leg.rate)), date: leg.date, source: 'CoinGecko and ECB via USD' };
      }
    } catch (err) {
      // A dollar stablecoin is a dollar for bookkeeping when the price feed is unreachable.
      if (!USD_PEGGED.has(from)) throw err;
      if (to === 'USD') quote = { from, to, rate: '1', date: date ?? todayIso(), source: 'pegged to USD (price feed unreachable)' };
      else {
        const leg = await fiatRate(fetch, 'USD', to, date);
        quote = { from, to, rate: leg.rate, date: leg.date, source: 'pegged to USD, then ECB reference rate' };
      }
    }
  } else if (!fromCrypto && toCrypto) {
    const inverse = await getRate(fetch, to, from, date);
    quote = { from, to, rate: fmtRate(1 / Number(inverse.rate)), date: inverse.date, source: inverse.source };
  } else {
    const a = await cryptoToFiat(fetch, from, 'USD', date);
    const b = await cryptoToFiat(fetch, to, 'USD', date);
    quote = { from, to, rate: fmtRate(a.rate / b.rate), date: a.date, source: 'CoinGecko via USD' };
  }
  cache.set(key, { quote, expires: Date.now() + (date && date < todayIso() ? 30 * 86_400_000 : 60 * 60_000) });
  return quote;
}

export function clearRateCache(): void {
  cache.clear();
}
