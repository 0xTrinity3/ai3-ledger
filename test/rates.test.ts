import { describe, it, expect } from 'vitest';
import { getRate, clearRateCache, isCrypto } from '../src/core/index.js';

function fake(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const f = async (url: string) => {
    calls.push(url);
    const key = Object.keys(routes).find((k) => url.startsWith(k));
    if (!key) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { f, calls };
}

describe('exchange rates', () => {
  it('knows which codes are crypto', () => {
    expect(isCrypto('USDC')).toBe(true);
    expect(isCrypto('EUR')).toBe(false);
  });

  it('uses the ECB for fiat, by date, and caches', async () => {
    clearRateCache();
    const { f, calls } = fake({ 'https://api.frankfurter.dev/v1/2026-09-01?base=EUR&symbols=USD': { date: '2026-09-01', rates: { USD: 1.0842 } } });
    const q = await getRate(f, 'EUR', 'USD', '2026-09-01');
    expect(q.rate).toBe('1.0842');
    expect(q.source).toContain('ECB');
    expect(q.date).toBe('2026-09-01');
    await getRate(f, 'eur', 'usd', '2026-09-01');
    expect(calls.length).toBe(1);
  });

  it('uses CoinGecko for stablecoins and inverts for fiat to crypto', async () => {
    clearRateCache();
    const { f } = fake({ 'https://api.coingecko.com/api/v3/simple/price?ids=usd-coin&vs_currencies=eur': { 'usd-coin': { eur: 0.92 } } });
    const q = await getRate(f, 'USDC', 'EUR');
    expect(q.rate).toBe('0.92');
    expect(q.source).toBe('CoinGecko');
    const inv = await getRate(f, 'EUR', 'USDC');
    expect(Number(inv.rate)).toBeCloseTo(1 / 0.92, 6);
  });

  it('returns 1 for the same currency and reports an unknown pair', async () => {
    clearRateCache();
    const { f } = fake({});
    expect((await getRate(f, 'USD', 'USD')).rate).toBe('1');
    await expect(getRate(f, 'EUR', 'XYZ')).rejects.toThrow(/answered 404/);
  });
});
