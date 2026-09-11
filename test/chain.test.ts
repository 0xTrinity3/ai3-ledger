/**
 * Wallets, the Tempo feed and the Recourse client: the parts that do not need
 * a chain or a venue. Memo round trips, chain logs to statement lines, the
 * dispute bundle against the venue's own validation rules, the sign-in
 * message in the layout the venue parses, and the wallet and dispute rows.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { createDispute, getDispute, getWallet, listDisputes, saveWallet, seedAccounts, updateDispute, getChainCursor, setChainCursor } from '../src/core/index.js';
import { centsToUnits, decodeMemo, encodeMemo, linesFrom, unitsToCents, PATH_USD_SYMBOL } from '../src/plugin/tempo.js';
import { DISPUTE_CLAUSE, RULEPACK, buildBundle, describeRuling, paymentHeader, signInHeader, siweMessage, type Requirements } from '../src/plugin/recourse.js';
import { TOOL_DECLARATIONS } from '../src/plugin/tools.js';

const CO = '12121212-1212-4121-8121-121212121212';
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const; // a well-known test key, holds nothing

let db: PluginTestDb;
beforeAll(async () => { db = await openPluginTestDb(); await seedAccounts(db, CO, 'USD'); });
afterAll(async () => { await db.close(); });

describe('tempo helpers', () => {
  it('memos round trip through 32 bytes', () => {
    const m = encodeMemo('INV-0042');
    expect(m).toMatch(/^0x[0-9a-f]{64}$/);
    expect(decodeMemo(m)).toBe('INV-0042');
    expect(decodeMemo('0x0000000000000000000000000000000000000000000000000000000000000000')).toBe('');
    expect(decodeMemo(encodeMemo('recourse:abcdef0123456789abcdef0123456789abcdef'))).toBe('recourse:abcdef0123456789abcdef0'); // clipped to 32 chars
  });
  it('converts cents and token units', () => {
    expect(centsToUnits(1250n)).toBe(12_500_000n);
    expect(unitsToCents(12_500_000n)).toBe(1250n);
  });
  it('turns chain transfers into signed statement lines with the memo as reference', () => {
    const me = '0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa';
    const other = '0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb';
    const ts = new Map<bigint, string>([[100n, '2026-09-11T12:00:00.000Z']]);
    const lines = linesFrom(me, [
      { txHash: '0xabc', logIndex: 0, blockNumber: 100n, from: other, to: me, units: 50_000_000n, memo: 'INV-0007' },
      { txHash: '0xdef', logIndex: 1, blockNumber: 100n, from: me, to: other, units: 1_000_000n, memo: '' },
    ], ts);
    expect(lines[0]).toMatchObject({ postedAt: '2026-09-11T12:00:00.000Z', amountMinor: 5000n, reference: 'INV-0007', externalId: '0xabc:0', payee: other });
    expect(lines[0]!.description).toContain(`${PATH_USD_SYMBOL} from ${other}`);
    expect(lines[1]).toMatchObject({ amountMinor: -100n, externalId: '0xdef:1' });
    expect(lines[1]!.reference).toBe('0xdef'.slice(0, 18));
  });
});

describe('recourse client', () => {
  const req: Requirements = { network: 'base', sandbox: true, case_fee_minor: 4900, consent_statement: 'I agree that any dispute I submit is determined by Recourse under the Recourse Standard Rules v1.0 (https://recourse.so/rules/v1.0), final and binding as a matter of contract.', accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '49000000', payTo: '0x000000000000000000000000000000000000dead', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', resource: 'https://recourse.so/disputes', maxTimeoutSeconds: 300 }] };

  it('signs in with a message in the layout the venue parses', async () => {
    const header = await signInHeader(KEY, req);
    const payload = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { address: string; message: string; signature: string; chainId: number };
    expect(payload.address).toBe(privateKeyToAccount(KEY).address);
    expect(payload.chainId).toBe(8453);
    const lines = payload.message.split('\n');
    expect(lines[0]).toBe('recourse.so wants you to sign in with your Ethereum account:');
    expect(lines[1]).toBe(payload.address);
    expect(lines[2]).toBe('');
    expect(lines[3]).toBe(req.consent_statement); // statement between the address and URI, as the venue slices it
    expect(payload.message).toContain('\nURI: https://recourse.so/disputes\nVersion: 1\nChain ID: 8453\nNonce: ');
    expect(payload.message).toMatch(/Issued At: \d{4}-\d{2}-\d{2}T/);
    expect(payload.signature).toMatch(/^0x[0-9a-f]{130}$/);
    expect(siweMessage({ domain: 'd', address: 'a', statement: 's', uri: 'u', chainId: 1, nonce: 'n', issuedAt: 't' })).toBe('d wants you to sign in with your Ethereum account:\na\n\ns\n\nURI: u\nVersion: 1\nChain ID: 1\nNonce: n\nIssued At: t');
  });

  it('builds an x402 exact payment from the wallet to the venue for the case fee', async () => {
    const header = await paymentHeader(KEY, req);
    const p = JSON.parse(Buffer.from(header, 'base64').toString('utf8')) as { x402Version: number; scheme: string; network: string; payload: { signature: string; authorization: { from: string; to: string; value: string } } };
    expect(p).toMatchObject({ x402Version: 1, scheme: 'exact', network: 'base' });
    expect(p.payload.authorization.from).toBe(privateKeyToAccount(KEY).address);
    expect(p.payload.authorization.to).toBe('0x000000000000000000000000000000000000dead');
    expect(BigInt(p.payload.authorization.value)).toBeGreaterThanOrEqual(49_000_000n);
    expect(p.payload.signature).toMatch(/^0x/);
  });

  it('builds a bundle the venue accepts: rulepack, currency, integer amount, terms, claim, log, deliverables, tempo settlement', () => {
    const b = buildBundle({
      role: 'claimant',
      invoice: { number: 'INV-0009', currency: 'USD', totalMinor: '50000', outstandingMinor: '50000', issuedAt: '2026-09-01T12:00:00.000Z', dueAt: '2026-10-01T12:00:00.000Z', lines: [{ description: 'Agent ops', quantity: '1', amountMinor: '50000' }], notes: null, url: 'https://ai3.co/i/abc', sellerName: 'Bluefin', buyerName: 'Harbor', sentAt: '2026-09-01T13:00:00.000Z', openedAt: '2026-09-02T09:00:00.000Z', payments: [] },
      breach: 'The report was delivered two weeks late and half the pages were blank.',
      remedy: 'Half the fee back.',
      evidence: null,
      amountMinor: 25000n,
      claimantAddress: '0x1111111111111111111111111111111111111111',
      respondentAddress: '0x2222222222222222222222222222222222222222',
      externalRef: 'ai3:co:d1',
    }) as Record<string, unknown> & { terms: { format: string; content: string }; claim: { by: string; claimed_breach: string; remedy_sought?: string }; log: Array<{ at: string; actor: string; kind: string }>; deliverables: unknown[]; settlement: { rail: string; network: string; asset: string; claimant_address: string; respondent_address: string } };
    expect(b['rulepack']).toBe(RULEPACK);
    expect(b['currency']).toBe('USD');
    expect(Number.isInteger(b['amount_minor'])).toBe(true);
    expect(b['amount_minor']).toBe(25000);
    expect(b.terms.format).toBe('text');
    expect(b.terms.content).toContain('Invoice INV-0009 from Bluefin to Harbor');
    expect(b.terms.content).toContain(DISPUTE_CLAUSE);
    expect(b.claim).toMatchObject({ by: 'claimant', remedy_sought: 'Half the fee back.' });
    expect(b.claim.claimed_breach.length).toBeGreaterThan(10);
    expect(b.log.map((l) => `${l.actor}:${l.kind}`)).toEqual(['respondent:status_change', 'platform:message', 'claimant:other', 'claimant:message']); // seller issued, sent, buyer opened, buyer claims
    expect(b.log.every((l, i, arr) => i === 0 || arr[i - 1]!.at <= l.at)).toBe(true);
    expect(b.deliverables).toHaveLength(2);
    expect(b.settlement).toEqual({ rail: 'tempo', network: 'tempo-testnet', asset: 'pathUSD', respondent_address: '0x2222222222222222222222222222222222222222', claimant_address: '0x1111111111111111111111111111111111111111' });
  });

  it('gives a non-USD invoice a ruling but no Tempo rail', () => {
    const b = buildBundle({ role: 'respondent', invoice: { number: 'INV-0001', currency: 'EUR', totalMinor: '1000', outstandingMinor: '1000', issuedAt: null, dueAt: null, lines: [], notes: null, url: null, sellerName: 'S', buyerName: 'B' }, breach: 'Unpaid.', claimantAddress: '0x1', respondentAddress: '0x2', externalRef: 'x' }) as Record<string, unknown>;
    expect(b['settlement']).toBeUndefined();
    expect((b['claim'] as { by: string }).by).toBe('respondent');
  });

  it('describes a ruling in one paragraph', () => {
    const text = describeRuling({ dispute_id: 'x', rulepack: RULEPACK, fault_allocation: { claimant_pct: 30, respondent_pct: 70 }, money_instruction: { type: 'split', to_respondent_minor: 15000, to_claimant_minor: 35000, currency: 'USD' }, summary: 'Late and incomplete.', reasoning: [], confidence: 0.82, escalate: false, tier: 1 });
    expect(text).toBe('Ruling (tier 1, confidence 82%): fault 30% claimant / 70% respondent; 150.00 USD to the respondent and 350.00 USD to the claimant. Late and incomplete.');
  });

  it('declares the wallet and dispute tools', () => {
    expect(TOOL_DECLARATIONS.map((t) => t.name)).toEqual(expect.arrayContaining(['wallet', 'pay-invoice', 'dispute-invoice', 'dispute', 'settle-dispute']));
  });
});

describe('wallet and dispute rows', () => {
  it('stores a wallet once and keeps its links', async () => {
    expect(await getWallet(db, CO)).toBeNull();
    const w = await saveWallet(db, { companyId: CO, network: 'tempo-moderato', address: '0xabc', privateKey: '0xkey' });
    expect(w.bankAccountId).toBeNull();
    const w2 = await saveWallet(db, { companyId: CO, network: 'tempo-moderato', address: '0xabc', privateKey: '0xkey', bankAccountId: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' });
    expect(w2.bankAccountId).toBe('0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f');
    expect(await getChainCursor(db, w2.bankAccountId!)).toBe(0n);
    await setChainCursor(db, w2.bankAccountId!, 34_854_470n);
    expect(await getChainCursor(db, w2.bankAccountId!)).toBe(34_854_470n);
  });
  it('files, decides and settles a dispute row', async () => {
    const d = await createDispute(db, { companyId: CO, invoiceNumber: 'INV-0009', invoiceUrl: 'https://ai3.co/i/abc', role: 'claimant', amountMinor: 25000n, currency: 'USD', claim: 'Late.', filedBy: 'agent:1', status: 'filing' });
    expect(d.status).toBe('filing');
    const decided = await updateDispute(db, CO, d.id, { caseId: 'case-1', status: 'decided', ruling: { summary: 'ok' }, instruction: { rail: 'tempo', transfer_intents: [] } });
    expect(decided.caseId).toBe('case-1');
    expect((decided.ruling as { summary: string }).summary).toBe('ok');
    expect((await getDispute(db, CO, 'case-1'))?.id).toBe(d.id);
    const settled = await updateDispute(db, CO, d.id, { status: 'settled', settledTx: '0xtx' });
    expect(settled.settledTx).toBe('0xtx');
    expect((await listDisputes(db, CO)).map((x) => x.id)).toContain(d.id);
  });
});
