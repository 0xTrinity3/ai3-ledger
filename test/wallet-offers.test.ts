/**
 * Crypto top-ups as the on-ramp to reconciliation.
 *
 * A card top-up tells you the issuer's country; a crypto one tells you the
 * account, because a public ledger has no choice but to name it. And the
 * transfer is itself signed by that account, so watching the wallet needs no
 * further proof. These tests pin the offer that comes out of that, and the
 * fact that it is an offer: a wallet is only watched when someone says so.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { getConnectedWallet, listConnectedWallets, seedAccounts, updateSettings } from '../src/core/index.js';
import { walletOffers, type CreditsView } from '../src/plugin/credits.js';
import { connectAddressWallet } from '../src/plugin/pay.js';

const CO = '77777777-7777-4777-8777-777777777777';
const PAYER = '0x3Bf06Af790E10ac39f0d07ECf68aefb8a7d6D354';
const OTHER = '0x1111111111111111111111111111111111111111';

let db: PluginTestDb;

function view(entries: CreditsView['entries']): CreditsView {
  return {
    hosted: true, keyed: true, slug: 'test-1234', at: '2026-09-12T12:00:00.000Z', markup: 0.2,
    platformWallet: '0x9999999999999999999999999999999999999999', memo: 'credit:test-1234',
    creditsUrl: null, modelUrl: null, grantedMinor: '2000', usageMinor: '0', chargedMinor: '0',
    remainingMinor: '2000', usageMonthlyMinor: '0', keyDisabled: false, entries, message: null,
  };
}

function entry(over: Record<string, unknown> = {}) {
  return {
    at: '2026-09-12T12:00:00.000Z', amountMinor: '2000', kind: 'crypto', ref: 'line:1',
    from: { address: PAYER.toLowerCase(), chainRef: 'tempo', txHash: '0xabc123', at: '2026-09-12T11:59:00.000Z' },
    ...over,
  } as CreditsView['entries'][number];
}

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  await updateSettings(db, CO, { baseCurrency: 'USD', ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
});
afterAll(async () => { await db.close(); });

describe('which wallets get offered', () => {
  it('offers the address that paid, with its chain and the transfer that proves it', () => {
    const [o, ...rest] = walletOffers(view([entry()]));
    expect(rest).toHaveLength(0);
    expect(o).toMatchObject({ address: PAYER.toLowerCase(), chainRef: 'tempo', txHash: '0xabc123', amountMinor: '2000', topUps: 1 });
  });

  it('offers nothing for a card top-up, which names no account', () => {
    expect(walletOffers(view([entry({ kind: 'stripe', from: undefined })]))).toEqual([]);
    expect(walletOffers(view([entry({ kind: 'free', from: undefined })]))).toEqual([]);
  });

  it('never offers a wallet that is already watched, whatever case it is written in', () => {
    expect(walletOffers(view([entry()]), [PAYER])).toEqual([]);
    expect(walletOffers(view([entry()]), [PAYER.toUpperCase()])).toEqual([]);
    expect(walletOffers(view([entry()]), [OTHER])).toHaveLength(1);
  });

  it('sums repeat top-ups from one address into one offer, keeping the latest transfer', () => {
    const offers = walletOffers(view([
      entry({ ref: 'line:1', amountMinor: '2000', from: { address: PAYER.toLowerCase(), chainRef: 'tempo', txHash: '0xold', at: '2026-09-10T10:00:00.000Z' } }),
      entry({ ref: 'line:2', amountMinor: '3000', from: { address: PAYER.toLowerCase(), chainRef: 'tempo', txHash: '0xnew', at: '2026-09-12T10:00:00.000Z' } }),
    ]));
    expect(offers).toHaveLength(1);
    expect(offers[0]).toMatchObject({ amountMinor: '5000', topUps: 2, txHash: '0xnew' });
  });

  it('never offers the zero address, which is where a mint comes from', () => {
    // Live tenant data carries faucet mints with payee 0x000…000.
    expect(walletOffers(view([entry({ from: { address: `0x${'0'.repeat(40)}`, chainRef: 'tempo', txHash: '0x1', at: null } })]))).toEqual([]);
  });

  it('ignores an address that is not an address', () => {
    expect(walletOffers(view([entry({ from: { address: 'not-an-address', chainRef: 'tempo', txHash: '0x1', at: null } })]))).toEqual([]);
  });

  it('puts the most recent first, one entry per address', () => {
    const offers = walletOffers(view([
      entry({ ref: 'line:1', from: { address: OTHER, chainRef: 'base', txHash: '0x1', at: '2026-09-01T10:00:00.000Z' } }),
      entry({ ref: 'line:2', from: { address: PAYER.toLowerCase(), chainRef: 'tempo', txHash: '0x2', at: '2026-09-12T10:00:00.000Z' } }),
    ]));
    expect(offers.map((o) => o.address)).toEqual([PAYER.toLowerCase(), OTHER]);
  });
});

describe('the top-up standing in for a signature', () => {
  it('records how the address was proved, and says which assurance it was', async () => {
    const r = await connectAddressWallet(db, CO, {
      network: 'tempo-moderato', address: PAYER,
      topUp: { txHash: '0xabc123', amountMinor: '2000', memo: 'credit:test-1234' },
    }, 'test');
    expect(r.proven).toBe(true);
    const w = await getConnectedWallet(db, CO, r.wallet.id);
    // Not dressed up as a signature check that never happened.
    expect(w!.proof).toMatchObject({ via: 'ai3-credit-top-up', txHash: '0xabc123', amountMinor: '2000', memo: 'credit:test-1234' });
    expect(w!.proof).not.toHaveProperty('signature');
    expect(w!.bankAccountId).toBeTruthy();
  });

  it('leaves an address unproven when there is neither a signature nor a top-up', async () => {
    const r = await connectAddressWallet(db, CO, { network: 'tempo-moderato', address: OTHER }, 'test');
    expect(r.proven).toBe(false);
    expect((await getConnectedWallet(db, CO, r.wallet.id))!.proof).toBeNull();
  });

  it('refuses to watch the same address twice, so a repeated offer cannot duplicate the books', async () => {
    await expect(connectAddressWallet(db, CO, {
      network: 'tempo-moderato', address: PAYER, topUp: { txHash: '0xabc123', amountMinor: '2000' },
    }, 'test')).rejects.toThrow(/already connected/);
    expect((await listConnectedWallets(db, CO)).filter((w) => w.address?.toLowerCase() === PAYER.toLowerCase())).toHaveLength(1);
  });
});
