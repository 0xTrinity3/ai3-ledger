/**
 * The ledger is sold, so some of it stops when it is not paid for. Which parts
 * stop, and — more importantly — which never do.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ALWAYS_ALLOWED, forgetEntitlements, gatedTool, ledgerEntitlement, notEntitledMessage } from '../src/plugin/market.js';
import { TOOL_DECLARATIONS } from '../src/plugin/tools.js';
import type { CompanySettings } from '../src/core/index.js';

const CO = 'company-1';
const connected = { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' } as unknown as CompanySettings;
const offline = {} as unknown as CompanySettings;

const answering = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const refusing = async () => { throw new Error('ECONNREFUSED'); };

beforeEach(() => forgetEntitlements());

describe('what never stops', () => {
  it('lets a company read its books, pay what it owes, and go to the venue', () => {
    for (const name of ['position', 'invoices', 'profit-and-loss', 'balance-sheet', 'wallet', 'credits']) {
      expect(gatedTool(name), `${name} must never be gated`).toBe(false);
    }
    // Paying is never gated: locking someone out of paying would stop them
    // paying the invoice that would put it right.
    for (const name of ['pay-invoice', 'record-payment']) {
      expect(gatedTool(name), `${name} must never be gated`).toBe(false);
    }
    // Every invoice names Recourse as its venue. Taking a dispute there cannot
    // depend on a subscription to the thing being disputed.
    for (const name of ['dispute-invoice', 'dispute', 'settle-dispute']) {
      expect(gatedTool(name), `${name} must never be gated`).toBe(false);
    }
  });

  it('stops the work that makes new obligations', () => {
    for (const name of ['create-invoice', 'send-invoice', 'reconcile', 'reconcile-all', 'write-off-invoice', 'void-invoice']) {
      expect(gatedTool(name), `${name} should be gated`).toBe(true);
    }
  });

  it('names only tools that exist, so a rename cannot quietly open the gate', () => {
    const declared = new Set(TOOL_DECLARATIONS.map((t) => t.name));
    for (const name of ALWAYS_ALLOWED) {
      expect(declared.has(name), `ALWAYS_ALLOWED lists "${name}", which is not a tool`).toBe(true);
    }
  });
});

describe('it fails open', () => {
  it('when ai3.co cannot be reached at all', async () => {
    const e = await ledgerEntitlement(refusing, connected, CO);
    expect(e.ok).toBe(true);
    expect(e.known).toBe(false);
    expect(e.reason).toMatch(/did not answer/);
  });

  it('when the company is not connected to ai3.co', async () => {
    const e = await ledgerEntitlement(refusing, offline, CO);
    expect(e.ok).toBe(true);
    expect(e.known).toBe(false);
  });

  it('when the ledger is not listed on that platform at all', async () => {
    const e = await ledgerEntitlement(answering(404, { error: 'No listing "ai3-ledger"' }), connected, CO);
    expect(e.ok).toBe(true);
    expect(e.reason).toMatch(/not listed/);
  });

  it('and keeps the last real answer through an outage rather than reverting', async () => {
    const no = await ledgerEntitlement(answering(402, { error: 'uninstalled' }), connected, CO, 1_000);
    expect(no.ok).toBe(false);
    // Cache expired, and now the server is down: the last decision stands.
    const during = await ledgerEntitlement(refusing, connected, CO, 1_000 + 31 * 60 * 1000);
    expect(during.ok).toBe(false);
    expect(during.known).toBe(true);
  });
});

describe('it does close', () => {
  it('when ai3.co says plainly that the company is not entitled', async () => {
    const e = await ledgerEntitlement(answering(402, { error: 'not entitled: paused by the owner' }), connected, CO);
    expect(e.ok).toBe(false);
    expect(e.known).toBe(true);
  });

  it('when the answer is a plain ok:false', async () => {
    const e = await ledgerEntitlement(answering(200, { ok: false, reason: 'uninstalled', installUrl: 'https://ai3.co/market' }), connected, CO);
    expect(e.ok).toBe(false);
    expect(e.reason).toBe('uninstalled');
  });

  it('and opens again when it is paid for', async () => {
    expect((await ledgerEntitlement(answering(200, { ok: true }), connected, CO)).ok).toBe(true);
  });

  it('tells the agent what still works and who can fix it', () => {
    const msg = notEntitledMessage('create-invoice', { ok: false, reason: 'uninstalled', known: true, installUrl: 'https://ai3.co/market', at: 0 });
    expect(msg).toMatch(/create-invoice is unavailable/);
    expect(msg).toMatch(/Reading the books, paying an invoice or a bill, and filing a dispute all still work/);
    expect(msg).toMatch(/ai3\.co\/market/);
  });
});

describe('it asks rarely', () => {
  it('caches an answer rather than asking on every tool call', async () => {
    let asked = 0;
    const counting = async () => { asked += 1; return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
    for (let i = 0; i < 5; i += 1) await ledgerEntitlement(counting, connected, CO, 1_000);
    expect(asked).toBe(1);
    await ledgerEntitlement(counting, connected, CO, 1_000 + 31 * 60 * 1000);
    expect(asked).toBe(2);
  });
});
