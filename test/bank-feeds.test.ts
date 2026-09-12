/**
 * Bank feeds through ai3.co: the bank account a provider account becomes, the
 * lines that arrive already signed the ledger's way, the rate-limit floor that
 * keeps a GoCardless account's daily cap intact, and a revoked authorisation
 * being reported rather than thrown. ai3.co is a fake fetch; the books are
 * real (pglite).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { listBankAccounts, listStatementLines, providerFor, searchInstitutions, seedAccounts, updateSettings, type CompanySettings } from '../src/core/index.js';
import {
  bankAccountName,
  bankFeedView,
  dueForSync,
  ensureBankAccounts,
  externalRefFor,
  linesFromBank,
  syncBankFeeds,
  MIN_SYNC_MINUTES,
  type BankConnectionView,
  type BankRemote,
} from '../src/plugin/banks.js';

const CO = '66666666-6666-4666-8666-666666666666';
const CONNECT_URL = 'https://ai3.test/start/bank?id=abc123';

let db: PluginTestDb;
let settings: CompanySettings;

/** What ai3.co says. Mutated per test; every call is recorded. */
let status: BankRemote;
let pages: Array<{ lines: unknown[]; cursor: string | null }> = [];
let txStatus = 200;
let txBody: unknown = null;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];

const fetch = async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  if (url.endsWith('/api/ledger/bank/status')) return new Response(JSON.stringify(status), { status: 200 });
  if (url.endsWith('/api/ledger/bank/link')) return new Response(JSON.stringify({ companyId: CO }), { status: 200 });
  if (url.endsWith('/api/ledger/bank/transactions')) {
    if (txStatus !== 200) return new Response(JSON.stringify(txBody ?? { error: 'that connection was revoked; the owner must reconnect' }), { status: txStatus });
    return new Response(JSON.stringify(pages.shift() ?? { lines: [], cursor: null }), { status: 200 });
  }
  return new Response('{}', { status: 200 });
};

function connection(over: Partial<BankConnectionView> = {}): BankConnectionView {
  return {
    id: 'gocardless:revolut_gb',
    provider: 'gocardless',
    institution: 'REVOLUT_REVOGB21',
    institutionName: 'Revolut Business',
    accounts: [{ id: 'acc_1', name: 'Main ••1234', kind: 'bank', currency: 'GBP', cursor: null, bankAccountId: null }],
    connectedAt: '2026-09-01T10:00:00.000Z',
    lastSyncedAt: null,
    revokedAt: null,
    error: null,
    ...over,
  };
}

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'GBP');
  settings = await updateSettings(db, CO, { baseCurrency: 'GBP', ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
  status = { providers: { plaid: true, gocardless: true }, connectUrl: CONNECT_URL, connections: [connection()] };
});
afterAll(async () => { await db.close(); });

describe('lines from ai3.co', () => {
  it('keeps the sign it was given, both ways', () => {
    // ai3.co has already inverted Plaid and passed GoCardless through, so the
    // same real event arrives identically from both.
    const out = linesFromBank('plaid', [{ postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '-500', description: 'Coffee', currency: 'GBP' }], 'GBP');
    const gc = linesFromBank('gocardless', [{ postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '-500', description: 'Coffee', currency: 'GBP' }], 'GBP');
    expect(out.lines[0]!.amountMinor).toBe(-500n);
    expect(gc.lines[0]!.amountMinor).toBe(-500n);
    expect(out.lines[0]!.externalId).toBeUndefined();
  });

  it('prefixes the provider on the external id, so two providers cannot collide', () => {
    const { lines } = linesFromBank('plaid', [{ postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '1000', description: 'In', externalId: 'txn_1', currency: 'GBP' }], 'GBP');
    expect(lines[0]!.externalId).toBe('plaid:txn_1');
  });

  it('drops a zero, a nonsense amount and a line with no date', () => {
    const { lines } = linesFromBank('gocardless', [
      { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '0', description: 'Nothing' },
      { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '12.34', description: 'Not minor units' },
      { postedAt: undefined as unknown as string, amountMinor: '100', description: 'No date' },
      { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '100', description: 'Good' },
    ], 'GBP');
    expect(lines.map((l) => l.description)).toEqual(['Good']);
  });

  it('counts a line in another currency instead of booking it at the wrong one', () => {
    const { lines, otherCurrency } = linesFromBank('gocardless', [
      { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '-2500', description: 'EUR spend', currency: 'EUR' },
      { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '-2500', description: 'GBP spend', currency: 'GBP' },
    ], 'GBP');
    expect(lines).toHaveLength(1);
    expect(lines[0]!.description).toBe('GBP spend');
    expect(otherCurrency).toBe(1);
  });

  it('treats a line with no currency as the account’s own', () => {
    const { lines, otherCurrency } = linesFromBank('plaid', [{ postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '-100', description: 'Unstated' }], 'USD');
    expect(lines).toHaveLength(1);
    expect(otherCurrency).toBe(0);
  });
});

describe('asking a provider no more often than it allows', () => {
  it('waits six hours for GoCardless and ten minutes for Plaid', () => {
    expect(MIN_SYNC_MINUTES.gocardless).toBe(360);
    const now = new Date('2026-09-12T12:00:00.000Z');
    const hoursAgo = (h: number) => new Date(now.getTime() - h * 3600_000).toISOString();
    expect(dueForSync(connection({ lastSyncedAt: hoursAgo(1) }), { now })).toBe(false);
    expect(dueForSync(connection({ lastSyncedAt: hoursAgo(7) }), { now })).toBe(true);
    expect(dueForSync(connection({ provider: 'plaid', lastSyncedAt: hoursAgo(1) }), { now })).toBe(true);
  });

  it('is due when it has never synced, and never when it is revoked', () => {
    expect(dueForSync(connection({ lastSyncedAt: null }))).toBe(true);
    expect(dueForSync(connection({ revokedAt: '2026-09-11T00:00:00.000Z' }))).toBe(false);
    // Even a person asking cannot pull a revoked connection; there is no credential.
    expect(dueForSync(connection({ revokedAt: '2026-09-11T00:00:00.000Z' }), { force: true })).toBe(false);
  });

  it('lets a person override the spacing', () => {
    const now = new Date('2026-09-12T12:00:00.000Z');
    const c = connection({ lastSyncedAt: new Date(now.getTime() - 60_000).toISOString() });
    expect(dueForSync(c, { now })).toBe(false);
    expect(dueForSync(c, { now, force: true })).toBe(true);
  });
});

describe('the bank account a provider account becomes', () => {
  it('names it after the bank and the account, without saying the bank twice', () => {
    expect(bankAccountName(connection(), connection().accounts[0]!)).toBe('Revolut Business · Main ••1234');
    const c = connection({ institutionName: 'Monzo' });
    expect(bankAccountName(c, { ...c.accounts[0]!, name: 'Monzo Business' })).toBe('Monzo Business');
  });

  it('creates one account under Treasury, links it back, and never creates a second', async () => {
    calls.length = 0;
    const pairs = await ensureBankAccounts(db, fetch, settings, CO, status, 'GBP');
    expect(pairs).toHaveLength(1);
    const bank = pairs[0]!.bank;
    expect(bank).toMatchObject({ kind: 'bank', feed: 'aggregator', currency: 'GBP', name: 'Revolut Business · Main ••1234' });
    expect(bank.externalRef).toBe(externalRefFor('gocardless', 'acc_1'));
    expect(bank.accountCode.startsWith('10')).toBe(true);
    const linked = calls.filter((c) => c.url.endsWith('/api/ledger/bank/link'));
    expect(linked).toHaveLength(1);
    expect(linked[0]!.body).toMatchObject({ companyId: CO, connection: 'gocardless:revolut_gb', account: 'acc_1', bankAccountId: bank.id });

    // Second time round, with ai3.co still not remembering the link: same account.
    status = { ...status, connections: [connection()] };
    const again = await ensureBankAccounts(db, fetch, settings, CO, status, 'GBP');
    expect(again[0]!.bank.id).toBe(bank.id);
    expect((await listBankAccounts(db, CO)).filter((b) => b.feed === 'aggregator')).toHaveLength(1);
  });

  it('leaves a revoked connection without a feed', async () => {
    const revoked: BankRemote = { providers: status.providers, connectUrl: CONNECT_URL, connections: [connection({ id: 'plaid:chase', provider: 'plaid', institutionName: 'Chase', revokedAt: '2026-09-11T00:00:00.000Z', accounts: [{ id: 'acc_dead', name: 'Old', kind: 'bank', currency: 'GBP', cursor: null, bankAccountId: null }] })] };
    expect(await ensureBankAccounts(db, fetch, settings, CO, revoked, 'GBP')).toHaveLength(0);
    expect((await listBankAccounts(db, CO)).some((b) => b.externalRef === externalRefFor('plaid', 'acc_dead'))).toBe(false);
  });
});

describe('pulling the lines in', () => {
  it('imports, advances the cursor, reconciles, and dedupes the second time', async () => {
    status = { providers: { plaid: true, gocardless: true }, connectUrl: CONNECT_URL, connections: [connection()] };
    pages = [
      { lines: [
        { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '2000', description: 'AI3 credit top-up', payee: 'AI3', externalId: 'gc_1', currency: 'GBP' },
        { postedAt: '2026-09-11T12:00:00.000Z', amountMinor: '-4999', description: 'Hetzner', externalId: 'gc_2', currency: 'GBP' },
      ], cursor: '2026-09-11' },
      { lines: [], cursor: '2026-09-11' },
    ];
    calls.length = 0;
    const r = await syncBankFeeds(db, fetch, settings, CO, { by: 'test', baseCurrency: 'GBP' });
    expect(r).not.toBeNull();
    expect(r!.imported).toBe(2);
    expect(r!.accounts).toBe(1);
    expect(r!.connections).toBe(1);
    expect(r!.waited).toBe(0);
    expect(r!.needsReconnect).toEqual([]);
    const bank = (await listBankAccounts(db, CO)).find((b) => b.feed === 'aggregator')!;
    const lines = await listStatementLines(db, CO, bank.id, { status: 'all' });
    expect(lines.map((l) => l.amountMinor).sort()).toEqual(['-4999', '2000']);
    expect(lines.every((l) => l.externalId?.startsWith('gocardless:'))).toBe(true);
    // The matcher was given the chance to post what it is sure of.
    expect(r!.autoPosted + r!.leftForReview).toBe(2);
    // The cursor it reached went back with the next request.
    const asked = calls.filter((c) => c.url.endsWith('/api/ledger/bank/transactions'));
    expect(asked.length).toBeGreaterThanOrEqual(2);
    expect(asked[1]!.body['cursor']).toBe('2026-09-11');

    // Same lines again: imported once, counted as duplicates thereafter.
    status = { providers: status.providers, connectUrl: CONNECT_URL, connections: [connection({ accounts: [{ id: 'acc_1', name: 'Main ••1234', kind: 'bank', currency: 'GBP', cursor: null, bankAccountId: bank.id }] })] };
    pages = [{ lines: [{ postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '2000', description: 'AI3 credit top-up', externalId: 'gc_1', currency: 'GBP' }], cursor: '2026-09-11' }];
    const second = await syncBankFeeds(db, fetch, settings, CO, { by: 'test', baseCurrency: 'GBP' });
    expect(second!.imported).toBe(0);
    expect(second!.duplicates).toBe(1);
    expect(await listStatementLines(db, CO, bank.id, { status: 'all' })).toHaveLength(2);
  });

  it('stops asking when the cursor stops moving', async () => {
    status = { providers: status.providers, connectUrl: CONNECT_URL, connections: [connection({ accounts: [{ id: 'acc_1', name: 'Main ••1234', kind: 'bank', currency: 'GBP', cursor: null, bankAccountId: null }] })] };
    pages = Array.from({ length: 30 }, () => ({ lines: [{ postedAt: '2026-09-10T12:00:00.000Z', amountMinor: '1', description: 'Same window', externalId: 'gc_same', currency: 'GBP' }], cursor: 'stuck' }));
    calls.length = 0;
    await syncBankFeeds(db, fetch, settings, CO, { by: 'test', baseCurrency: 'GBP' });
    expect(calls.filter((c) => c.url.endsWith('/api/ledger/bank/transactions')).length).toBeLessThanOrEqual(3);
  });

  it('reports a revoked authorisation instead of throwing, so the other banks still sync', async () => {
    status = { providers: status.providers, connectUrl: CONNECT_URL, connections: [connection({ accounts: [{ id: 'acc_1', name: 'Main ••1234', kind: 'bank', currency: 'GBP', cursor: null, bankAccountId: null }] })] };
    txStatus = 409;
    txBody = { error: 'that connection was revoked; the owner must reconnect' };
    const r = await syncBankFeeds(db, fetch, settings, CO, { by: 'test', baseCurrency: 'GBP' });
    txStatus = 200;
    txBody = null;
    expect(r!.needsReconnect).toEqual(['Revolut Business · Main ••1234']);
    expect(r!.perAccount[0]!.reconnect).toBe(true);
    expect(r!.perAccount[0]!.error).toMatch(/reconnect/);
    expect(r!.imported).toBe(0);
  });

  it('asks for nothing when the provider floor has not passed', async () => {
    status = { providers: status.providers, connectUrl: CONNECT_URL, connections: [connection({ lastSyncedAt: new Date().toISOString(), accounts: [{ id: 'acc_1', name: 'Main ••1234', kind: 'bank', currency: 'GBP', cursor: null, bankAccountId: null }] })] };
    calls.length = 0;
    const r = await syncBankFeeds(db, fetch, settings, CO, { by: 'bank-feed', baseCurrency: 'GBP' });
    expect(r!.waited).toBe(1);
    expect(calls.filter((c) => c.url.endsWith('/api/ledger/bank/transactions'))).toHaveLength(0);
    // A person asking gets through.
    pages = [{ lines: [], cursor: null }];
    const forced = await syncBankFeeds(db, fetch, settings, CO, { by: 'board', force: true, baseCurrency: 'GBP' });
    expect(forced!.waited).toBe(0);
    expect(calls.filter((c) => c.url.endsWith('/api/ledger/bank/transactions'))).toHaveLength(1);
  });

  it('does nothing at all without a company key, or without a connection', async () => {
    const bare = { ...settings, ai3Key: null, ai3Origin: null } as CompanySettings;
    expect(await syncBankFeeds(db, fetch, bare, CO, {})).toBeNull();
    status = { providers: { plaid: false, gocardless: false }, connectUrl: CONNECT_URL, connections: [] };
    expect(await syncBankFeeds(db, fetch, settings, CO, {})).toBeNull();
  });
});

describe('the page that does the authorising', () => {
  it('carries ai3.co\u2019s bank page into the finance view, because the tenant cannot run that flow', async () => {
    status = { providers: { plaid: true, gocardless: true }, connectUrl: CONNECT_URL, connections: [connection()] };
    const view = await bankFeedView(db, fetch, settings, CO);
    expect(view.ai3Connected).toBe(true);
    expect(view.connectUrl).toBe(CONNECT_URL);
    expect(view.providers).toEqual({ plaid: true, gocardless: true });
    const bare = await bankFeedView(db, fetch, { ...settings, ai3Key: null, ai3Origin: null } as CompanySettings, CO);
    expect(bare).toMatchObject({ ai3Connected: false, connectUrl: null, connections: [], accounts: [] });
  });
});

describe('the catalogue only names providers that are wired', () => {
  it('routes the UK to GoCardless, not to a provider with no credentials', () => {
    expect(providerFor('GB')).toBe('gocardless');
    expect(providerFor('US')).toBe('plaid');
    expect(providerFor('DE')).toBe('gocardless');
    const uk = searchInstitutions('', 'GB').filter((i) => i.connectionType === 'automatic feed');
    expect(uk.length).toBeGreaterThan(0);
    expect(uk.every((i) => i.provider === 'plaid' || i.provider === 'gocardless')).toBe(true);
  });
});
