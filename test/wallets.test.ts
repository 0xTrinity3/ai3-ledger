/**
 * Connected wallets and exchange feeds: the rows, the vault, the chain
 * registry, the three exchange clients against recorded responses and the
 * signing each exchange documents, and the exchange feed end to end into a
 * bank account. Nothing here touches a chain or an exchange.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { generateKeyPairSync, verify as cryptoVerify } from 'node:crypto';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import {
  archiveConnectedWallet,
  connectedWalletForBank,
  createBankAccount,
  createConnectedWallet,
  findConnectedAddress,
  getBankAccount,
  getVaultKey,
  listBankAccounts,
  listConnectedWallets,
  listStatementLines,
  readConnectedCredentials,
  seedAccounts,
  setConnectedSync,
} from '../src/core/index.js';
import { seal, unseal } from '../src/plugin/vault.js';
import { CHAINS, chainForPaymentOption, chainOf, chainSummary, linesFrom, unitsToCents, centsToUnits } from '../src/plugin/chains.js';
import { EXCHANGES, binanceQuery, coinbaseJwt, decimalToCents, krakenSign, linesFromEntries, exchangeSummaries } from '../src/plugin/exchanges.js';
import { connectExchangeAccount, ownershipMessage, syncConnectedWallet, verifyOwnership } from '../src/plugin/pay.js';
import { FEED_INSTITUTIONS, searchInstitutions } from '../src/core/index.js';
import { privateKeyToAccount } from 'viem/accounts';

const CO = '77777777-7777-4777-8777-777777777777';
const ADDR = '0x1111111111111111111111111111111111111111';

let db: PluginTestDb;
beforeAll(async () => { db = await openPluginTestDb(); await seedAccounts(db, CO, 'USD'); });
afterAll(async () => { await db.close(); });

type FakeFetch = (url: string, init?: RequestInit) => Promise<Response>;
function fakeFetch(routes: Record<string, (url: URL, init?: RequestInit) => unknown>): FakeFetch & { calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const f = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const u = new URL(url);
    const key = Object.keys(routes).find((k) => u.pathname === k || u.pathname.startsWith(k));
    if (!key) return new Response(JSON.stringify({ message: `no route ${u.pathname}` }), { status: 404 });
    const body = routes[key]!(u, init);
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as FakeFetch & { calls: typeof calls };
  f.calls = calls;
  return f;
}

describe('connected wallet rows', () => {
  it('stores an address wallet once per network, finds it by bank account and case-insensitively by address', async () => {
    const bank = await createBankAccount(db, CO, { name: 'Base treasury', kind: 'wallet', currency: 'USD', feed: 'chain', externalRef: `base:${ADDR}` });
    expect(bank.feed).toBe('chain');
    const w = await createConnectedWallet(db, CO, { kind: 'address', label: 'Base treasury', network: 'base', address: ADDR, currency: 'USD', bankAccountId: bank.id, createdBy: 'board' });
    expect(w.kind).toBe('address');
    expect(w.hasCredentials).toBe(false);
    expect((await connectedWalletForBank(db, CO, bank.id))?.id).toBe(w.id);
    expect((await findConnectedAddress(db, CO, 'base', ADDR.toUpperCase().replace('0X', '0x')))?.id).toBe(w.id);
    await expect(createConnectedWallet(db, CO, { kind: 'address', label: 'Again', network: 'base', address: ADDR.toLowerCase(), currency: 'USD' })).rejects.toThrow(/already connected/);
    await expect(createConnectedWallet(db, CO, { kind: 'address', label: 'Bad', network: 'base', address: '0x123', currency: 'USD' })).rejects.toThrow(/40 hex/);
    await setConnectedSync(db, CO, w.id, { lastError: 'rpc down' });
    expect((await listConnectedWallets(db, CO))[0]?.lastError).toBe('rpc down');
    const gone = await archiveConnectedWallet(db, CO, w.id);
    expect(gone.archivedAt).not.toBeNull();
    expect(await listConnectedWallets(db, CO)).toHaveLength(0);
    expect((await listBankAccounts(db, CO)).find((b) => b.id === bank.id)).toBeUndefined(); // archived with it
    expect((await getBankAccount(db, CO, bank.id))?.id).toBe(bank.id); // still there for the books
  });
  it('refuses an exchange account without credentials', async () => {
    await expect(createConnectedWallet(db, CO, { kind: 'exchange', label: 'Kraken', exchange: 'kraken', currency: 'USD' })).rejects.toThrow(/credentials/);
  });
});

describe('vault', () => {
  it('seals and unseals under a key generated once per database', async () => {
    expect(await getVaultKey(db)).toBeNull();
    const blob = await seal(db, '{"apiKey":"k","secret":"s"}');
    expect(blob.startsWith('v1.')).toBe(true);
    expect(blob).not.toContain('apiKey');
    expect(await unseal(db, blob)).toBe('{"apiKey":"k","secret":"s"}');
    const key = await getVaultKey(db);
    expect(key).toMatch(/^[A-Za-z0-9+/=]{40,}$/);
    expect(await seal(db, 'x')).not.toBe(await seal(db, 'x')); // fresh iv each time
    await expect(unseal(db, `${blob.slice(0, -4)}AAAA`)).rejects.toThrow();
  });
});

describe('chain registry', () => {
  it('knows Tempo, Base and Ethereum with one stablecoin each', () => {
    expect(Object.keys(CHAINS).sort()).toEqual(['base', 'ethereum', 'tempo-moderato']);
    expect(chainOf('BASE')?.chainId).toBe(8453);
    expect(chainOf('ethereum')?.token.address).toBe('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(chainOf('tempo-moderato')?.token.memo).toBe(true);
    expect(chainOf('solana')).toBeNull();
    const s = chainSummary(CHAINS['base']!);
    expect(s.chainIdHex).toBe('0x2105');
    expect(s.nativeCurrency.symbol).toBe('ETH');
  });
  it('resolves an invoice payment option by chain slug first, then by network label, and only for the chain stablecoin', () => {
    expect(chainForPaymentOption({ chain: 'base', network: 'whatever', asset: 'USDC' })?.slug).toBe('base');
    expect(chainForPaymentOption({ network: 'Tempo Moderato testnet', asset: 'pathUSD' })?.slug).toBe('tempo-moderato');
    expect(chainForPaymentOption({ network: 'Ethereum mainnet', asset: 'USDC' })?.slug).toBe('ethereum');
    expect(chainForPaymentOption({ network: 'Ethereum', asset: 'ETH' })).toBeNull();
    expect(chainForPaymentOption({ network: 'Solana', asset: 'USDC' })).toBeNull();
  });
  it('turns transfers into signed lines in cents, dropping dust', () => {
    const c = CHAINS['base']!;
    expect(centsToUnits(c, 1250n)).toBe(12_500_000n);
    expect(unitsToCents(c, 12_500_000n)).toBe(1250n);
    const other = '0x2222222222222222222222222222222222222222';
    const lines = linesFrom(c, ADDR, [
      { txHash: '0xabc', logIndex: 0, blockNumber: 10n, from: other, to: ADDR, units: 50_000_000n, memo: '' },
      { txHash: '0xdef', logIndex: 1, blockNumber: 10n, from: ADDR, to: other, units: 1_000_000n, memo: '' },
      { txHash: '0xdust', logIndex: 2, blockNumber: 10n, from: ADDR, to: other, units: 5n, memo: '' },
    ], new Map([[10n, '2026-09-12T10:00:00.000Z']]));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ amountMinor: 5000n, payee: other, externalId: '0xabc:0' });
    expect(lines[0]!.description).toContain('USDC from');
    expect(lines[1]).toMatchObject({ amountMinor: -100n });
  });
  it('lists wallets and exchanges in the Add bank account catalogue', () => {
    const ids = FEED_INSTITUTIONS.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['wallet-tempo', 'wallet-base', 'wallet-ethereum', 'coinbase', 'kraken', 'binance']));
    expect(searchInstitutions('coinbase')[0]).toMatchObject({ provider: 'exchange', exchange: 'coinbase', connectionType: 'API key' });
    expect(searchInstitutions('base wallet')[0]).toMatchObject({ provider: 'chain', network: 'base', connectionType: 'wallet address' });
  });
});

describe('ownership proof', () => {
  it('verifies a signature from the address and rejects another address', async () => {
    const key = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
    const account = privateKeyToAccount(key);
    const message = ownershipMessage('Bluefin Studio', account.address, '2026-09-12T10:00:00.000Z');
    expect(message).toContain(account.address);
    const signature = await account.signMessage({ message });
    expect(await verifyOwnership(account.address, message, signature)).toBe(true);
    expect(await verifyOwnership(ADDR, message, signature)).toBe(false);
    expect(await verifyOwnership(account.address, `${message}x`, signature)).toBe(false);
  });
});

describe('exchange signing and money', () => {
  it('rounds decimal amounts to cents', () => {
    expect(decimalToCents('12.345678')).toBe(1235n);
    expect(decimalToCents('-0.004')).toBe(0n);
    expect(decimalToCents('-1.5')).toBe(-150n);
    expect(decimalToCents(3)).toBe(300n);
    expect(() => decimalToCents('abc')).toThrow();
  });
  it('signs a Kraken request the way the API documentation shows', () => {
    // The worked example in Kraken's REST authentication guide.
    const secret = 'kQH5HW/8p1uGOVjbgWA7FunAmGO8lsSUXNsu3eow76sz84Q18fWxnyRzBHCd3pd5nE9qa99HAZtuZuj6F1huXg==';
    const sig = krakenSign('/0/private/AddOrder', '1616492376594', 'nonce=1616492376594&ordertype=limit&pair=XBTUSD&price=37500&type=buy&volume=1.25', secret);
    expect(sig).toBe('4/dpxb3iT4tp/ZCVEwSnEsLxx0bqyhLpdfOpc6fn7OR8+UClSV5n9E6aSS8MPtnRfp32bAb0nmbRn6H8ndwLUQ==');
  });
  it('signs a Binance query with HMAC-SHA256 over the query string', () => {
    const q = binanceQuery({ coin: 'USDC', timestamp: '1700000000000' }, 'secret');
    expect(q).toMatch(/^coin=USDC&timestamp=1700000000000&signature=[0-9a-f]{64}$/);
  });
  it('builds a Coinbase JWT for an EC key (ES256) and an Ed25519 key (EdDSA) that verify with the public key', () => {
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const pem = ec.privateKey.export({ format: 'pem', type: 'sec1' }).toString();
    const jwt = coinbaseJwt({ apiKey: 'organizations/o/apiKeys/k', secret: pem }, 'GET', '/v2/accounts', 1_700_000_000);
    const [h, p, sig] = jwt.split('.');
    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p!, 'base64url').toString());
    expect(header).toMatchObject({ alg: 'ES256', kid: 'organizations/o/apiKeys/k', typ: 'JWT' });
    expect(payload).toMatchObject({ sub: 'organizations/o/apiKeys/k', iss: 'cdp', nbf: 1_700_000_000, exp: 1_700_000_120, uri: 'GET api.coinbase.com/v2/accounts' });
    expect(cryptoVerify('sha256', Buffer.from(`${h}.${p}`), { key: ec.publicKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig!, 'base64url'))).toBe(true);

    const ed = generateKeyPairSync('ed25519');
    const pkcs8 = ed.privateKey.export({ format: 'der', type: 'pkcs8' });
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const pub = ed.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
    const jwt2 = coinbaseJwt({ apiKey: 'organizations/o/apiKeys/e', secret: Buffer.concat([seed, pub]).toString('base64') }, 'GET', '/v2/accounts');
    const [h2, p2, sig2] = jwt2.split('.');
    expect(JSON.parse(Buffer.from(h2!, 'base64url').toString()).alg).toBe('EdDSA');
    expect(cryptoVerify(null, Buffer.from(`${h2}.${p2}`), ed.publicKey, Buffer.from(sig2!, 'base64url'))).toBe(true);
  });
  it('describes the three exchanges for the key form', () => {
    const s = exchangeSummaries();
    expect(s.map((e) => e.id)).toEqual(['coinbase', 'kraken', 'binance']);
    expect(s.every((e) => e.fields.some((f) => f.secret))).toBe(true);
  });
});

describe('exchange clients against recorded responses', () => {
  it('reads a Coinbase currency ledger across accounts and pages, newest first, stopping at since', async () => {
    const fetch = fakeFetch({
      '/v2/accounts/acc-usdc/transactions': (u) => (u.searchParams.get('starting_after')
        ? { data: [{ id: 't3', type: 'send', status: 'completed', amount: { amount: '-25.00', currency: 'USDC' }, created_at: '2026-09-01T10:00:00Z', details: { title: 'Sent USDC', subtitle: 'To 0xabc' }, network: { hash: '0xhash3' } }, { id: 'old', type: 'buy', status: 'completed', amount: { amount: '1.00', currency: 'USDC' }, created_at: '2026-01-01T00:00:00Z' }] }
        : { data: [{ id: 't1', type: 'buy', status: 'completed', amount: { amount: '100.123', currency: 'USDC' }, created_at: '2026-09-10T10:00:00Z', details: { title: 'Bought USDC', subtitle: 'Using USD wallet' } }, { id: 't2', type: 'send', status: 'pending', amount: { amount: '-5', currency: 'USDC' }, created_at: '2026-09-09T10:00:00Z' }], pagination: { next_uri: '/v2/accounts/acc-usdc/transactions?limit=100&starting_after=t2' } }),
      '/v2/accounts': () => ({ data: [{ id: 'acc-usd', currency: { code: 'USD' } }, { id: 'acc-usdc', currency: { code: 'USDC' } }] }),
    });
    const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const creds = { apiKey: 'organizations/o/apiKeys/k', secret: ec.privateKey.export({ format: 'pem', type: 'sec1' }).toString() };
    expect(await EXCHANGES.coinbase.validate(fetch, creds)).toMatchObject({ ok: true });
    const entries = await EXCHANGES.coinbase.entries(fetch, creds, 'usdc', '2026-08-01T00:00:00.000Z');
    expect(entries.map((e) => e.id)).toEqual(['t3', 't1']); // pending skipped, old one stopped the page, oldest first
    expect(entries[0]).toMatchObject({ amountMinor: -2500n, reference: '0xhash3' });
    expect(entries[1]).toMatchObject({ amountMinor: 10012n, description: 'Coinbase Bought USDC · Using USD wallet' });
    expect(fetch.calls.every((c) => String((c.init?.headers as Record<string, string>)['authorization']).startsWith('Bearer ey'))).toBe(true);
  });
  it('reads a Kraken ledger for one asset with fees netted and Z-prefixed codes matched', async () => {
    const fetch = fakeFetch({
      '/0/private/Balance': () => ({ error: [], result: { ZUSD: '10.00', USDC: '5.00' } }),
      '/0/private/Ledgers': (_u, init) => {
        const body = String(init?.body);
        expect(body).toContain('asset=ZUSD');
        return { error: [], result: { ledger: {
          L1: { refid: 'R1', time: 1_757_600_000, type: 'deposit', subtype: '', aclass: 'currency', asset: 'ZUSD', amount: '500.00', fee: '0.00', balance: '500.00' },
          L2: { refid: 'R2', time: 1_757_700_000, type: 'trade', subtype: '', aclass: 'currency', asset: 'ZUSD', amount: '-120.50', fee: '0.30', balance: '379.20' },
          L3: { refid: 'R3', time: 1_757_700_100, type: 'trade', subtype: '', aclass: 'currency', asset: 'USDC', amount: '120.00', fee: '0', balance: '120.00' },
        }, count: 3 } };
      },
    });
    const creds = { apiKey: 'k', secret: Buffer.from('secret').toString('base64') };
    expect(await EXCHANGES.kraken.validate(fetch, creds)).toMatchObject({ ok: true, detail: '2 balance(s) visible' });
    const entries = await EXCHANGES.kraken.entries(fetch, creds, 'USD', '2026-09-01T00:00:00.000Z');
    expect(entries.map((e) => e.id)).toEqual(['L1', 'L2']);
    expect(entries[1]).toMatchObject({ amountMinor: -12080n, reference: 'R2' });
    expect(entries[1]!.description).toContain('fee 0.30');
    const signed = fetch.calls[0]!.init?.headers as Record<string, string>;
    expect(signed['API-Key']).toBe('k');
    expect(signed['API-Sign']).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
  it('reads Binance deposits and withdrawals, refusing a key that can withdraw', async () => {
    const fetch = fakeFetch({
      '/sapi/v1/account/apiRestrictions': (u) => ({ enableReading: true, enableWithdrawals: u.searchParams.get('signature')?.startsWith('ff') === true }),
      '/sapi/v1/capital/deposit/hisrec': () => [{ id: 'd1', amount: '250.5', coin: 'USDC', status: 1, insertTime: 1_757_600_000_000, txId: '0xdep', network: 'BASE', address: '0xmine' }, { id: 'd2', amount: '9', coin: 'USDC', status: 0, insertTime: 1_757_600_000_000 }],
      '/sapi/v1/capital/withdraw/history': () => [{ id: 'w1', amount: '100', transactionFee: '0.5', coin: 'USDC', status: 6, completeTime: '2026-09-11 10:00:00', txId: '0xwd', network: 'BASE', address: '0xthem' }],
    });
    const creds = { apiKey: 'k', secret: 's' };
    const v = await EXCHANGES.binance.validate(fetch, creds);
    expect(v.ok).toBe(true);
    const entries = await EXCHANGES.binance.entries(fetch, creds, 'USDC', '2026-09-01T00:00:00.000Z');
    expect(entries.map((e) => e.id)).toEqual(['dep:d1', 'wd:w1']);
    expect(entries[0]!.amountMinor).toBe(25050n);
    expect(entries[1]!.amountMinor).toBe(-10050n);
    expect(fetch.calls[0]!.init?.headers).toMatchObject({ 'X-MBX-APIKEY': 'k' });
    expect(new URL(fetch.calls[1]!.url).searchParams.get('signature')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('exchange feed end to end', () => {
  it('connects Kraken after checking the key, seals the credentials, and reads its ledger into the bank account', async () => {
    const fetch = fakeFetch({
      '/0/private/Balance': () => ({ error: [], result: { ZUSD: '10.00' } }),
      '/0/private/Ledgers': () => ({ error: [], result: { ledger: { K1: { refid: 'RA', time: Math.floor(Date.now() / 1000) - 3600, type: 'deposit', asset: 'ZUSD', amount: '1000.00', fee: '0', balance: '1000.00' } }, count: 1 } }),
    });
    const r = await connectExchangeAccount(db, fetch, CO, { exchange: 'kraken', apiKey: 'key', secret: Buffer.from('s').toString('base64'), currency: 'usd', sinceDays: 7 }, 'board');
    expect(r.wallet).toMatchObject({ kind: 'exchange', exchange: 'kraken', currency: 'USD', label: 'Kraken · USD', hasCredentials: true });
    const sealed = await readConnectedCredentials(db, CO, r.wallet.id);
    expect(sealed).toMatch(/^v1\./);
    expect(JSON.parse(await unseal(db, sealed!))).toEqual({ apiKey: 'key', secret: Buffer.from('s').toString('base64') });
    const bank = await getBankAccount(db, CO, r.wallet.bankAccountId!);
    expect(bank).toMatchObject({ kind: 'wallet', feed: 'exchange', currency: 'USD' });

    const sync = await syncConnectedWallet(db, fetch, CO, r.wallet, { by: 'test', autoPost: false });
    expect(sync).toMatchObject({ imported: 1, duplicates: 0, error: null });
    const lines = await listStatementLines(db, CO, bank!.id);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ amountMinor: '100000', externalId: 'kraken:K1', payee: 'Kraken' });
    const again = await syncConnectedWallet(db, fetch, CO, (await listConnectedWallets(db, CO)).find((w) => w.id === r.wallet.id)!, { by: 'test', autoPost: false });
    expect(again).toMatchObject({ imported: 0, duplicates: 1 });
    expect((await listConnectedWallets(db, CO)).find((w) => w.id === r.wallet.id)?.lastSyncAt).not.toBeNull();
  });
  it('refuses a Binance key that can withdraw before storing anything', async () => {
    const fetch = fakeFetch({ '/sapi/v1/account/apiRestrictions': () => ({ enableReading: true, enableWithdrawals: true }) });
    await expect(connectExchangeAccount(db, fetch, CO, { exchange: 'binance', apiKey: 'k', secret: 's', currency: 'USDC' }, 'board')).rejects.toThrow(/can withdraw/);
    expect((await listConnectedWallets(db, CO)).filter((w) => w.exchange === 'binance')).toHaveLength(0);
  });
  it('records a failing read on the wallet instead of throwing', async () => {
    const fetch = fakeFetch({ '/0/private/Balance': () => ({ error: [], result: {} }), '/0/private/Ledgers': () => ({ error: ['EAPI:Invalid key'], result: {} }) });
    const r = await connectExchangeAccount(db, fetch, CO, { exchange: 'kraken', apiKey: 'k2', secret: Buffer.from('s').toString('base64'), currency: 'EUR' }, 'board');
    const sync = await syncConnectedWallet(db, fetch, CO, r.wallet, { by: 'test' });
    expect(sync.error).toMatch(/Invalid key/);
    expect((await listConnectedWallets(db, CO)).find((w) => w.id === r.wallet.id)?.lastError).toMatch(/Invalid key/);
    expect(linesFromEntries('kraken', [{ id: 'z', at: '2026-01-01T00:00:00.000Z', amountMinor: 0n, type: 'x', description: 'zero', reference: null }])).toHaveLength(0);
  });
});
