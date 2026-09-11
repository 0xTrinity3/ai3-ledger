/**
 * M6: the agent tools and the morning briefing, against the plugin-mode
 * database. ai3.co is a fake fetch; the host's tool gateway is not involved,
 * we call the dispatcher the way the worker does.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { openPluginTestDb, type PluginTestDb } from './harness.js';
import { createBankAccount, importStatementLines, seedAccounts, updateSettings, postTransaction, ACCOUNT } from '../src/core/index.js';
import { TOOL_DECLARATIONS, majorToMinor, minorToMajor, runTool, type ToolDeps } from '../src/plugin/tools.js';
import { buildBriefing } from '../src/plugin/briefing.js';
import manifest from '../src/manifest.js';
import { LEDGER_SKILL, ledgerSkillMarkdown } from '../src/plugin/skill.js';

const CO = '88888888-8888-4888-8888-888888888888';
const RUN = { agentId: 'agent-1', runId: 'run-1', companyId: CO, projectId: 'proj-1' };

let db: PluginTestDb;
let deps: ToolDeps;
const calls: string[] = [];

beforeAll(async () => {
  db = await openPluginTestDb();
  await seedAccounts(db, CO, 'USD');
  deps = {
    db,
    baseCurrency: 'USD',
    companyName: async () => 'Tools Co',
    fetch: async (url: string) => {
      calls.push(url);
      const body = url.endsWith('/api/ledger/invoices')
        ? { token: 't1', url: 'https://ai3.test/i/t1' }
        : url.endsWith('/send')
          ? { sentAt: new Date().toISOString(), from: 'owner@example.com', via: 'gmail' }
          : url.includes('frankfurter')
            ? { base: 'EUR', date: '2026-09-11', rates: { USD: 1.08 } }
            : {};
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
});
afterAll(async () => { await db.close(); });

describe('money at the tool boundary', () => {
  it('converts major units both ways', () => {
    expect(majorToMinor('1250.00')).toBe(125000n);
    expect(majorToMinor('1,250.5')).toBe(125050n);
    expect(majorToMinor('-3')).toBe(-300n);
    expect(minorToMajor(125050n)).toBe('1250.50');
    expect(minorToMajor('-5')).toBe('-0.05');
    expect(() => majorToMinor('12.345')).toThrow(/two decimals/);
    expect(() => majorToMinor('abc')).toThrow();
  });
});

describe('manifest', () => {
  it('declares every tool the dispatcher knows, with schemas and no destructive names', () => {
    expect(manifest.tools).toBe(TOOL_DECLARATIONS);
    expect(manifest.capabilities).toContain('agent.tools.register');
    for (const t of TOOL_DECLARATIONS) {
      expect(t.parametersSchema).toMatchObject({ type: 'object' });
      // Paperclip infers "destructive" from these words and would demand approval; the board chose no gate.
      expect(t.name).not.toMatch(/delete|destroy|remove|drop|truncate|wipe|purge/);
    }
    expect(manifest.apiRoutes?.some((r) => r.routeKey === 'tools.invoke' && r.auth === 'board-or-agent' && r.path === '/tools/:name')).toBe(true);
    expect(manifest.capabilities).toContain('skills.managed');
    expect(manifest.skills?.[0]).toBe(LEDGER_SKILL);
    const md = ledgerSkillMarkdown();
    for (const t of TOOL_DECLARATIONS) expect(md).toContain(`### ${t.name}`);
    expect(md).toContain('/api/plugins/ai3.ledger/api/tools/');
    expect(TOOL_DECLARATIONS.map((t) => t.name)).toEqual([
      'position', 'invoices', 'invoice', 'customers', 'create-invoice', 'send-invoice', 'record-payment', 'void-invoice', 'write-off-invoice',
      'bank-accounts', 'reconcile-queue', 'reconcile', 'reconcile-all', 'profit-and-loss', 'balance-sheet',
    ]);
  });
});

describe('agent tools', () => {
  it('refuses an unknown tool and bad params with an error, not a throw', async () => {
    expect(await runTool(deps, 'nope', {}, RUN)).toEqual({ error: 'Unknown tool nope' });
    const r = await runTool(deps, 'create-invoice', { customer: 'X', lines: [{ description: 'a', unitAmount: 'lots' }] }, RUN);
    expect(r.error).toMatch(/unitAmount/);
  });

  it('reads an empty position', async () => {
    const r = await runTool(deps, 'position', {}, RUN);
    expect(r.error).toBeUndefined();
    expect(r.content).toMatch(/Treasury 0.00 USD/);
    expect((r.data as { treasury: string }).treasury).toBe('0.00');
  });

  it('creates a customer and issues an invoice in one call, then lists and reads it', async () => {
    await postTransaction(db, { companyId: CO, occurredAt: new Date(), description: 'Funding', sourcePlatform: 'manual', currency: 'USD', sourceKind: 'funding', sourceRef: 'fund-1', entries: [{ accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: 1_000_000n }, { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: 1_000_000n }] });
    const r = await runTool(deps, 'create-invoice', { customer: 'Northwind', customerEmail: 'ap@northwind.example', lines: [{ description: 'Agent ops, September', unitAmount: '1250.00' }, { description: 'Support', quantity: '2', unitAmount: '100' }], dueInDays: 14, notes: 'Thanks' }, RUN);
    expect(r.error).toBeUndefined();
    const d = r.data as { number: string; status: string; total: string; link: string | null; customer: string };
    expect(d.status).toBe('issued');
    expect(d.total).toBe('1450.00');
    expect(d.customer).toBe('Northwind');
    expect(d.link).toBeNull(); // not connected yet
    const list = await runTool(deps, 'invoices', { status: 'issued' }, RUN);
    expect((list.data as { invoices: unknown[] }).invoices).toHaveLength(1);
    const one = await runTool(deps, 'invoice', { invoice: d.number }, RUN);
    expect((one.data as { lines: unknown[]; notes: string }).lines).toHaveLength(2);
    expect((one.data as { notes: string }).notes).toBe('Thanks');
    const custs = await runTool(deps, 'customers', {}, RUN);
    expect((custs.data as { customers: Array<{ name: string; email: string }> }).customers[0]).toMatchObject({ name: 'Northwind', email: 'ap@northwind.example' });
    const pos = await runTool(deps, 'position', {}, RUN);
    expect((pos.data as { receivables: string }).receivables).toBe('1450.00');
  });

  it('cannot send until the company is connected, then publishes and sends', async () => {
    const no = await runTool(deps, 'send-invoice', { invoice: 'INV-0001' }, RUN);
    expect(no.error).toMatch(/not connected/);
    await updateSettings(db, CO, { ai3Key: 'ai3k_test', ai3Origin: 'https://ai3.test' });
    const yes = await runTool(deps, 'send-invoice', { invoice: 'INV-0001', message: 'Hi' }, RUN);
    expect(yes.error).toBeUndefined();
    expect(yes.content).toMatch(/emailed to ap@northwind.example from owner@example.com/);
    expect(calls.filter((u) => u.endsWith('/api/ledger/invoices'))).toHaveLength(1);
    expect(calls.filter((u) => u.endsWith('/send'))).toHaveLength(1);
    const d = yes.data as { link: string; sentTo: string };
    expect(d.link).toBe('https://ai3.test/i/t1');
    expect(d.sentTo).toBe('ap@northwind.example');
  });

  it('issues a foreign-currency invoice at the looked-up rate and sends it in the same call', async () => {
    const r = await runTool(deps, 'create-invoice', { customer: 'northwind', currency: 'EUR', lines: [{ description: 'EU work', unitAmount: '100' }], sendTo: 'eu@northwind.example' }, RUN);
    expect(r.error).toBeUndefined();
    const d = r.data as { currency: string; sent: { via: string }; number: string };
    expect(d.currency).toBe('EUR');
    expect(d.sent.via).toBe('gmail');
    const one = await runTool(deps, 'invoice', { invoice: d.number }, RUN);
    expect(Number((one.data as { rateToBase: string }).rateToBase)).toBe(1.08);
  });

  it('records a part payment then the rest by default', async () => {
    const part = await runTool(deps, 'record-payment', { invoice: 'INV-0001', amount: '450', date: '2026-09-10', reference: 'BACS 1' }, RUN);
    expect(part.error).toBeUndefined();
    expect((part.data as { status: string; outstanding: string }).status).toBe('part_paid');
    expect((part.data as { outstanding: string }).outstanding).toBe('1000.00');
    const rest = await runTool(deps, 'record-payment', { invoice: 'INV-0001', reference: 'BACS 2' }, RUN);
    expect((rest.data as { status: string }).status).toBe('paid');
    const pos = await runTool(deps, 'position', {}, RUN);
    expect((pos.data as { treasury: string }).treasury).toBe('11450.00');
  });

  it('voids a draft and writes off an open invoice without any gate', async () => {
    const draft = await runTool(deps, 'create-invoice', { customer: 'Northwind', lines: [{ description: 'Oops', unitAmount: '10' }], issue: false }, RUN);
    expect((draft.data as { status: string }).status).toBe('draft');
    const v = await runTool(deps, 'void-invoice', { invoice: (draft.data as { number: string }).number }, RUN);
    expect((v.data as { status: string }).status).toBe('void');
    const bad = await runTool(deps, 'create-invoice', { customer: 'Deadbeat Ltd', lines: [{ description: 'Never paid', unitAmount: '300' }] }, RUN);
    const w = await runTool(deps, 'write-off-invoice', { invoice: (bad.data as { number: string }).number, reason: 'gone bust' }, RUN);
    expect(w.error).toBeUndefined();
    expect((w.data as { status: string }).status).toBe('written_off');
  });

  it('reconciles statement lines: accept a proposal, decide one by hand, then the rest above threshold', async () => {
    const bank = await createBankAccount(db, CO, { name: 'Mercury', kind: 'bank', currency: 'USD' });
    await importStatementLines(db, CO, bank.id, [
      { postedAt: '2026-09-10T12:00:00.000Z', amountMinor: 45000n, description: 'Northwind BACS 1', reference: 'BACS 1' },
      { postedAt: '2026-09-11T12:00:00.000Z', amountMinor: -2000n, description: 'GitHub subscription', payee: 'GitHub' },
      { postedAt: '2026-09-12T12:00:00.000Z', amountMinor: -2000n, description: 'GitHub subscription Oct', payee: 'GitHub', reference: 'oct' },
    ]);
    const banks = await runTool(deps, 'bank-accounts', {}, RUN);
    expect((banks.data as { bankAccounts: Array<{ unreconciled: number }> }).bankAccounts[0]!.unreconciled).toBe(3);
    const q = await runTool(deps, 'reconcile-queue', {}, RUN);
    const queue = (q.data as { queue: Array<{ lineId: string; description: string; proposal: { kind: string; confidence: number } }> }).queue;
    expect(queue).toHaveLength(3);
    const payment = queue.find((l) => l.description.includes('Northwind'))!;
    expect(payment.proposal.kind).toBe('match');
    const a = await runTool(deps, 'reconcile', { lineId: payment.lineId, accept: true }, RUN);
    expect(a.error).toBeUndefined();
    const gh = queue.filter((l) => l.description.includes('GitHub'));
    const b = await runTool(deps, 'reconcile', { lineId: gh[0]!.lineId, decision: { kind: 'create', accountCode: '5100', description: 'GitHub', contactName: 'GitHub' } }, RUN);
    expect(b.error).toBeUndefined();
    const all = await runTool(deps, 'reconcile-all', { threshold: 80 }, RUN);
    expect(all.error).toBeUndefined();
    expect((all.data as { posted: number; waiting: number }).posted + (all.data as { waiting: number }).waiting).toBe(1);
    expect((all.data as { posted: number }).posted).toBe(1); // the rule learned from the first GitHub line
    const after = await runTool(deps, 'bank-accounts', {}, RUN);
    expect((after.data as { bankAccounts: Array<{ unreconciled: number }> }).bankAccounts[0]!.unreconciled).toBe(0);
  });

  it('reports profit and loss and a balancing balance sheet', async () => {
    const pnl = await runTool(deps, 'profit-and-loss', { from: '2026-09-01', to: '2026-09-30' }, RUN);
    expect(pnl.error).toBeUndefined();
    const pd = pnl.data as { income: string; expense: string; lines: Array<{ code: string }> };
    expect(Number(pd.income)).toBeGreaterThan(0);
    expect(pd.lines.some((l) => l.code === '5100')).toBe(true);
    const bs = await runTool(deps, 'balance-sheet', {}, RUN);
    expect((bs.data as { balances: boolean }).balances).toBe(true);
  });
});

describe('briefing', () => {
  it('lists what needs attention and stays quiet when nothing does', async () => {
    const b = await buildBriefing(db, CO, new Date('2026-12-01T09:00:00.000Z'));
    expect(b).not.toBeNull();
    expect(b!.items.some((i) => i.line.includes('overdue'))).toBe(true); // the EUR invoice is 30 days past due by December
    expect(b!.body).toMatch(/Position on 2026-12-01/);
    const quiet = '99999999-9999-4999-8999-999999999999';
    await seedAccounts(db, quiet, 'USD');
    expect(await buildBriefing(db, quiet)).toBeNull();
  });
});
