/**
 * The spending-authority gate at the pay-invoice tool: an agent pays only
 * inside what its owner granted on ai3.co, a person is not asked, and every
 * refusal is a sentence the agent can pass on. ai3.co and the Tempo rail are
 * both fakes; the database is the real plugin schema.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { seedAccounts, updateSettings } from '../src/core/index.js';
import { runTool, type ToolDeps } from '../src/plugin/tools.js';
import { explainRefusal, isAgentActor, NOT_CONNECTED, claimFromVerdict, type Verdict } from '../src/plugin/authority.js';
import { ledgerSkillMarkdown } from '../src/plugin/skill.js';

const CO = '77777777-7777-4777-7777-777777777777';
const AGENT = { agentId: 'agent-9', runId: 'run-9', companyId: CO, projectId: '' };
const BOARD = { agentId: 'board:jo', runId: '', companyId: CO, projectId: '' };
const INVOICE_URL = 'https://ai3.test/i/abcdefghijklmnopqrstuv';
const SELLER_WALLET = '0x' + '1'.repeat(40);

let db: PluginTestDb;
let deps: ToolDeps;
const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
let checkReply: Record<string, unknown> = { allowed: true, code: 'ok', authorityId: 'auth_' + 'b'.repeat(24) };
let paidReply: { status: number; body: Record<string, unknown> } = { status: 200, body: { ok: true, paymentId: 'pay_9' } };
let paid: Array<{ to: string; amountCents: bigint; memo: string }> = [];

const fetch = async (url: string, init?: RequestInit) => {
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
  calls.push({ url, body });
  let reply: unknown = {};
  let status = 200;
  if (url.endsWith('.json')) {
    reply = {
      number: 'INV-0007', currency: 'USD', totalMinor: '2500', outstandingMinor: '2500', status: 'issued', lines: [],
      paymentMethods: [{ kind: 'crypto', label: 'pathUSD on Tempo', details: { network: 'Tempo Moderato testnet', address: SELLER_WALLET } }],
      company: { name: 'Northwind Reconciler', email: null }, stripe: { payable: false },
      seller: { companyId: 'cmp_seller', orgId: 'org_' + 's'.repeat(24), slug: 'northwind', name: 'Northwind Reconciler' },
    };
  } else if (url.endsWith('/api/ledger/agent-pay/check')) {
    reply = checkReply;
  } else if (url.endsWith('/api/ledger/agent-pay/paid')) {
    reply = paidReply.body; status = paidReply.status;
  } else if (url.endsWith('/paid')) {
    reply = { ok: true };
  }
  return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
};

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD', { version: 1 });
  await updateSettings(db, CO, { baseCurrency: 'USD', ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
  deps = {
    db, fetch, companyName: async () => 'Buyer Co', baseCurrency: 'USD',
    pay: async (_wallet, input) => { paid.push(input); return { txHash: '0x' + 'f'.repeat(64), explorer: 'https://explore.test/tx/0xf', blockNumber: '1' } as never; },
  };
});
afterAll(async () => { await db.close(); });
beforeEach(() => { calls.length = 0; paid = []; checkReply = { allowed: true, code: 'ok', authorityId: 'auth_' + 'b'.repeat(24) }; paidReply = { status: 200, body: { ok: true, paymentId: 'pay_9' } }; });

describe('who is asked', () => {
  it('an agent is; the board is not', () => {
    expect(isAgentActor('agent-9')).toBe(true);
    expect(isAgentActor('board:jo')).toBe(false);
  });
});

describe('an agent paying from the wallet', () => {
  it('asks ai3.co first, names the seller’s organization as the payee, pays, then reports with the authority', async () => {
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toBeUndefined();
    const check = calls.find((c) => c.url.endsWith('/api/ledger/agent-pay/check'));
    expect(check?.body).toMatchObject({ companyId: CO, payee: 'org_' + 's'.repeat(24), payeeName: 'Northwind Reconciler', amountMinor: '2500', currency: 'USD', invoiceId: 'INV-0007' });
    expect(calls.findIndex((c) => c.url.endsWith('/agent-pay/check'))).toBeLessThan(calls.findIndex((c) => c.url.endsWith('/agent-pay/paid')));
    expect(paid).toHaveLength(1);
    expect(paid[0]).toMatchObject({ to: SELLER_WALLET, amountCents: 2500n, memo: 'INV-0007' });
    const report = calls.find((c) => c.url.endsWith('/api/ledger/agent-pay/paid'));
    expect(report?.body).toMatchObject({ payee: 'org_' + 's'.repeat(24), amountMinor: '2500', invoiceId: 'INV-0007', rail: 'tempo', chain: 'tempo-moderato', txHash: '0x' + 'f'.repeat(64), authorityId: 'auth_' + 'b'.repeat(24) });
    expect(r.content).toContain('against the owner’s spending authority');
    expect(r.data).toMatchObject({ authorityId: 'auth_' + 'b'.repeat(24), counted: true });
  });

  it('is refused when there is no authority, with where to grant one, and nothing moves', async () => {
    checkReply = { allowed: false, code: 'no-authority', why: 'This organization has not authorised agent payments to this payee.', configureUrl: 'https://ai3.test/o/buyer/authorities' };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toMatch(/not paid: the owner has not authorised agent payments to Northwind Reconciler/);
    expect(r.error).toContain('https://ai3.test/o/buyer/authorities');
    expect(paid).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith('/agent-pay/paid'))).toBe(false);
  });

  it('waits while the inspection window is open and says when to ask again', async () => {
    checkReply = { allowed: false, code: 'window-open', windowEndsAt: '2026-09-15T12:00:00.000Z', feedUrl: 'https://ai3.test/feed#act_1', actionId: 'act_1' };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toMatch(/not paid yet: 25\.00 USD to Northwind Reconciler is in the owner's feed for inspection until 2026-09-15T12:00:00.000Z/);
    expect(r.error).toContain('https://ai3.test/feed#act_1');
    expect(r.error).toContain('Do not pay it another way');
    expect(paid).toHaveLength(0);
  });

  it('is refused over a cap, and told not to split the payment', async () => {
    checkReply = { allowed: false, code: 'over-transaction-cap', capMinor: '1000' };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toMatch(/over the per-payment cap of 10\.00 USD/);
    expect(r.error).toContain('Do not split it');
    expect(paid).toHaveLength(0);
  });

  it('is refused when the buyer\u2019s own acceptance check failed, and told to dispute with the verdict', async () => {
    checkReply = { allowed: false, code: 'failed-check', verdictId: 'vrd_' + 'x'.repeat(24), failed: ['five_sources', 'memo_length'] };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toMatch(/acceptance check failed for this invoice \(five_sources, memo_length\)/);
    expect(r.error).toContain('vrd_' + 'x'.repeat(24));
    expect(r.error).toContain('Do not pay work recorded as not done');
    expect(paid).toHaveLength(0);
  });

  it('is frozen by an open dispute, whatever the caps say', async () => {
    checkReply = { allowed: false, code: 'disputed', dispute: { invoice: 'INV-0007', status: 'open', venueUrl: 'https://recourse.test/c/1' } };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toMatch(/open dispute with Northwind Reconciler on INV-0007/);
    expect(r.error).toContain('https://recourse.test/c/1');
    expect(paid).toHaveLength(0);
  });

  it('cannot pay at all when the company is not connected to ai3.co', async () => {
    await updateSettings(db, CO, { ai3Key: null, ai3Origin: null });
    try {
      const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
      expect(r.error).toBe(NOT_CONNECTED);
      expect(paid).toHaveLength(0);
    } finally {
      await updateSettings(db, CO, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
    }
  });

  it('uses the address as the payee when there is no invoice link', async () => {
    const r = await runTool(deps, 'pay-invoice', { to: SELLER_WALLET, amount: '5.00', memo: 'top-up' }, AGENT);
    expect(r.error).toBeUndefined();
    const check = calls.find((c) => c.url.endsWith('/api/ledger/agent-pay/check'));
    expect(check?.body).toMatchObject({ payee: SELLER_WALLET, amountMinor: '500', invoiceId: null });
  });

  it('still pays, and says so, when the receipt does not reach ai3.co', async () => {
    paidReply = { status: 503, body: { error: 'later' } };
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, AGENT);
    expect(r.error).toBeUndefined();
    expect(paid).toHaveLength(1);
    expect(r.content).toContain('was not reported to the spending authority');
    expect(r.data).toMatchObject({ counted: false });
  });
});

describe('a person paying from the board', () => {
  it('is not asked, and nothing is reported as an autonomous payment', async () => {
    const r = await runTool(deps, 'pay-invoice', { invoiceUrl: INVOICE_URL, rail: 'tempo' }, BOARD);
    expect(r.error).toBeUndefined();
    expect(paid).toHaveLength(1);
    expect(calls.some((c) => c.url.includes('/agent-pay/'))).toBe(false);
    expect(r.data).toMatchObject({ authorityId: null, counted: null });
  });
});

describe('a failed verdict as a claim', () => {
  const verdict: Verdict = { id: 'vrd_1', checkId: 'chk_abc', model: 'openai/gpt-5-mini', producerModel: 'anthropic/claude-haiku-4.5', pass: false, failed: ['five_sources'], slug: 'research-desk', version: 2, deliveryRef: 'INV-0007', at: '2026-09-15T12:00:00.000Z', rules: [{ id: 'memo_schema', kind: 'schema', pass: true, evidence: 'validates against the schema' }, { id: 'five_sources', kind: 'min_count', pass: false, evidence: '3 at sources, fewer than 5', reason: 'Fewer than five sources is one person\u2019s opinion with links.' }] };
  it('puts the failed rules, their reasons and the recorded evidence in the breach', () => {
    const c = claimFromVerdict(verdict, { breach: 'The memo is thin.' });
    expect(c.breach).toMatch(/^The memo is thin\.\nThe delivery for INV-0007 failed 1 of 2 rules of the listing's acceptance check \(chk_abc, research-desk v2\), scored by openai\/gpt-5-mini on a model different from the seller/);
    expect(c.breach).toContain('- five_sources (Fewer than five sources is one person\u2019s opinion with links.): 3 at sources, fewer than 5');
    expect(c.evidence).toContain('Verdict vrd_1 as recorded at ai3.co.');
    expect(c.evidence).toContain('memo_schema: pass');
    expect(c.evidence).toContain('five_sources: FAIL');
  });
  it('refuses a verdict that passed', () => {
    expect(() => claimFromVerdict({ ...verdict, pass: true, failed: [] })).toThrow(/passed every rule/);
  });
});

describe('the words', () => {
  it('every refusal code has a sentence, and the skill tells the agent to stop', () => {
    for (const code of ['no-authority', 'window-open', 'needs-first-approval', 'over-transaction-cap', 'over-period-cap', 'over-budget-policy', 'disputed', 'vetoed', 'deferred', 'paused', 'revoked', 'chain-not-enabled', 'failed-check', 'something-new']) {
      const text = explainRefusal({ allowed: false, code, why: 'because' }, { payeeName: 'X', amountMinor: 100n, currency: 'USD' });
      expect(text.startsWith('not paid')).toBe(true);
    }
    expect(ledgerSkillMarkdown()).toContain('spending authority');
    expect(ledgerSkillMarkdown()).toContain('Never split a');
  });
});
