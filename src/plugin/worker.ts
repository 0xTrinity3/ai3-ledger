/**
 * Paperclip plugin worker for the AI3 Ledger.
 *
 * Everything platform-specific lives in this directory. The worker wires
 * Paperclip's `ctx.db` (namespaced schema, SELECT-only query, single-statement
 * execute) to the platform-neutral core in statements mode, runs the cost sweep
 * as a scheduled job across every company on the instance, and answers the
 * scoped API routes declared in the manifest.
 */
import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import type { PluginApiRequestInput, PluginApiResponse, PluginContext } from '@paperclipai/plugin-sdk';
import {
  ACCOUNT,
  LedgerError,
  accountBalances,
  cleanupPending,
  fromMinor,
  listTransactions,
  position,
  postTransaction,
  seedAccounts,
  sweepCosts,
  toMinor,
  createCustomer,
  listCustomers,
  createInvoice,
  getInvoice,
  listInvoices,
  issueInvoice,
  recordPayment,
  writeOffInvoice,
  voidInvoice,
  type InvoiceStatus,
  listPeriods,
  createPeriod,
  ensureMonth,
  closePeriod,
  profitAndLoss,
  balanceSheet,
  getPeriod,
  listBankAccounts,
  getBankAccount,
  createBankAccount,
  importStatementLines,
  listStatementLines,
  getStatementLine,
  saveProposal,
  parseStatement,
  propose,
  applyDecision,
  runReconciliation,
  decisionOf,
  listRules,
  setRuleEnabled,
  lastRun,
  searchInstitutions,
  FEED_INSTITUTIONS,
  getSettings,
  updateSettings,
  listPaymentMethods,
  createPaymentMethod,
  updatePaymentMethod,
  setInvoicePaymentMethods,
  getRate,
  setInvoiceHosted,
  markInvoiceSent,
  markInvoiceOpened,
  type PaymentKind,
  type Decision,
  type BankKind,
  type GroupBy,
  type LedgerDb,
  type SweepResult,
} from '../core/index.js';
import { paperclipCostSource } from './cost-source.js';
import { Ai3Error, hostedStatus, isConnected, publishInvoice, revokeInvoice, sendInvoice } from './ai3.js';

const CURRENCY = 'USD';
const SWEEP_JOB = 'sweep';

let ctx: PluginContext | null = null;
let db: LedgerDb | null = null;
let lastSweep: { at: string; results: SweepResult[]; errors: Array<{ companyId: string; error: string }> } | null = null;

function ledger(): LedgerDb {
  if (!db) throw new Error('ledger plugin is not set up');
  return db;
}

async function sweepCompany(companyId: string): Promise<SweepResult> {
  const l = ledger();
  await seedAccounts(l, companyId, CURRENCY);
  return sweepCosts(l, paperclipCostSource(l.sql), companyId, { currency: CURRENCY });
}

async function sweepAll(): Promise<void> {
  const c = ctx;
  if (!c) return;
  const results: SweepResult[] = [];
  const errors: Array<{ companyId: string; error: string }> = [];
  const removed = await cleanupPending(ledger(), 10);
  if (removed > 0) c.logger.warn('ledger: removed stale pending transactions', { removed });
  const companies = await c.companies.list({ limit: 500 });
  for (const company of companies) {
    try {
      const r = await sweepCompany(company.id);
      results.push(r);
      if (r.posted > 0) c.logger.info('ledger: swept costs', { companyId: company.id, posted: r.posted, read: r.read });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ companyId: company.id, error: message });
      c.logger.error('ledger: sweep failed', { companyId: company.id, error: message });
    }
  }
  lastSweep = { at: new Date().toISOString(), results, errors };
}

function json(status: number, body: unknown): PluginApiResponse {
  return { status, body };
}

function bad(message: string, status = 400): PluginApiResponse {
  return json(status, { error: message });
}

function str(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

async function handle(input: PluginApiRequestInput): Promise<PluginApiResponse> {
  const l = ledger();
  const companyId = input.companyId;
  await seedAccounts(l, companyId, CURRENCY);

  switch (input.routeKey) {
    case 'position': {
      const p = await position(l, companyId);
      if (input.actor.actorType === 'agent' && input.actor.agentId) {
        const mine = await listTransactions(l, companyId, { agentRef: input.actor.agentId, limit: 500 });
        const spent = mine
          .flatMap((t) => t.entries)
          .filter((e) => e.direction === 'debit' && e.accountCode.startsWith('5'))
          .reduce((acc, e) => acc + toMinor(e.amountMinor), 0n);
        return json(200, {
          companyId,
          currency: p.currency,
          treasuryMinor: p.treasuryMinor,
          agent: { agentId: input.actor.agentId, spentMinor: fromMinor(spent), transactions: mine.length },
        });
      }
      return json(200, p);
    }
    case 'accounts': {
      const rows = await accountBalances(l, companyId);
      return json(200, {
        companyId,
        accounts: rows.map((a) => ({
          code: a.code,
          name: a.name,
          type: a.type,
          currency: a.currency,
          debitMinor: fromMinor(a.debitMinor),
          creditMinor: fromMinor(a.creditMinor),
          balanceMinor: fromMinor(a.balanceMinor),
        })),
      });
    }
    case 'transactions': {
      const q = input.query;
      const limitRaw = Number(str(q['limit']) ?? 50);
      const rows = await listTransactions(l, companyId, {
        ...(str(q['from']) ? { from: String(str(q['from'])) } : {}),
        ...(str(q['to']) ? { to: String(str(q['to'])) } : {}),
        ...(str(q['agentRef']) ? { agentRef: String(str(q['agentRef'])) } : {}),
        limit: Number.isFinite(limitRaw) ? limitRaw : 50,
      });
      return json(200, { companyId, transactions: rows });
    }
    case 'funding': {
      if (input.actor.actorType !== 'user') return bad('Only the board can record funding', 403);
      const body = (input.body ?? {}) as Record<string, unknown>;
      let amount: bigint;
      try {
        amount = toMinor(body['amountMinor']);
      } catch {
        return bad('amountMinor must be an integer number of minor units');
      }
      if (amount <= 0n) return bad('amountMinor must be positive');
      const occurredAt = typeof body['occurredAt'] === 'string' ? body['occurredAt'] : new Date().toISOString();
      const description = typeof body['description'] === 'string' ? body['description'] : 'Funding';
      const reference = typeof body['reference'] === 'string' && body['reference'] ? body['reference'] : null;
      try {
        const r = await postTransaction(l, {
          companyId,
          occurredAt,
          description,
          sourcePlatform: 'manual',
          sourceKind: 'funding',
          sourceRef: reference,
          currency: CURRENCY,
          createdBy: input.actor.userId ?? 'board',
          entries: [
            { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: amount },
            { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: amount },
          ],
        });
        return json(r.inserted ? 201 : 200, { transactionId: r.transactionId, publicId: r.publicId, inserted: r.inserted });
      } catch (err) {
        if (err instanceof LedgerError) return bad(err.message, err.code === 'period_closed' ? 409 : 400);
        throw err;
      }
    }
    case 'sweep': {
      if (input.actor.actorType !== 'user') return bad('Only the board can run a sweep', 403);
      const r = await sweepCompany(companyId);
      return json(200, r);
    }
    default:
      return handleInvoicing(input, l, companyId);
  }
}

const INVOICE_STATUSES: InvoiceStatus[] = ['draft', 'issued', 'part_paid', 'paid', 'written_off', 'void'];

function bodyOf(input: PluginApiRequestInput): Record<string, unknown> {
  return input.body && typeof input.body === 'object' ? (input.body as Record<string, unknown>) : {};
}

function who(input: PluginApiRequestInput): string {
  return input.actor.actorType === 'agent' ? `agent:${input.actor.agentId ?? input.actor.actorId}` : input.actor.userId ?? 'board';
}

async function handleInvoicing(input: PluginApiRequestInput, l: LedgerDb, companyId: string): Promise<PluginApiResponse> {
  const board = input.actor.actorType === 'user';
  const body = bodyOf(input);
  const id = input.params['id'] ?? '';
  try {
    switch (input.routeKey) {
      case 'customers.list':
        return json(200, { companyId, customers: await listCustomers(l, companyId) });
      case 'customers.create': {
        if (!board) return bad('Only the board can add customers', 403);
        const c = await createCustomer(l, companyId, {
          name: String(body['name'] ?? ''),
          email: typeof body['email'] === 'string' ? body['email'] : null,
          externalRef: typeof body['externalRef'] === 'string' ? body['externalRef'] : null,
        });
        return json(201, c);
      }
      case 'invoices.list': {
        const q = input.query;
        const status = str(q['status']);
        const customerId = str(q['customerId']);
        const limitRaw = Number(str(q['limit']) ?? 100);
        return json(200, {
          companyId,
          invoices: await listInvoices(l, companyId, {
            ...(status && (INVOICE_STATUSES as string[]).includes(status) ? { status: status as InvoiceStatus } : {}),
            ...(customerId ? { customerId } : {}),
            limit: Number.isFinite(limitRaw) ? limitRaw : 100,
          }),
        });
      }
      case 'invoices.get': {
        const inv = await getInvoice(l, companyId, id);
        return inv ? json(200, inv) : bad('Invoice not found', 404);
      }
      case 'invoices.create': {
        // An agent's invoice is a draft with the agent recorded on it. Nothing
        // reaches a report until a person issues it (acceptance criterion 8).
        const subject = {
          ...(typeof body['workRef'] === 'string' && body['workRef'] ? { work: body['workRef'] } : {}),
          ...(typeof body['goalRef'] === 'string' && body['goalRef'] ? { goal: body['goalRef'] } : {}),
          ...(board
            ? typeof body['agentRef'] === 'string' && body['agentRef']
              ? { agent: body['agentRef'] }
              : {}
            : input.actor.agentId
              ? { agent: input.actor.agentId }
              : {}),
        };
        const lines = Array.isArray(body['lines']) ? (body['lines'] as Array<Record<string, unknown>>) : [];
        const inv = await createInvoice(l, companyId, {
          customerId: String(body['customerId'] ?? ''),
          currency: CURRENCY,
          dueAt: typeof body['dueAt'] === 'string' ? body['dueAt'] : null,
          subject,
          createdBy: who(input),
          lines: lines.map((x) => ({
            description: String(x['description'] ?? ''),
            quantity: typeof x['quantity'] === 'number' || typeof x['quantity'] === 'string' ? x['quantity'] : 1,
            unitAmountMinor: typeof x['unitAmountMinor'] === 'number' || typeof x['unitAmountMinor'] === 'string' ? x['unitAmountMinor'] : '',
          })),
        });
        return json(201, inv);
      }
      case 'invoices.issue': {
        if (!board) return bad('Only the board can issue an invoice', 403);
        const inv = await issueInvoice(l, companyId, id, {
          ...(typeof body['issuedAt'] === 'string' ? { issuedAt: body['issuedAt'] } : {}),
          createdBy: who(input),
        });
        return json(200, inv);
      }
      case 'invoices.payment': {
        if (!board) return bad('Only the board can record a payment', 403);
        const inv = await recordPayment(l, companyId, id, {
          amountMinor: typeof body['amountMinor'] === 'number' || typeof body['amountMinor'] === 'string' ? body['amountMinor'] : '',
          ...(typeof body['occurredAt'] === 'string' ? { occurredAt: body['occurredAt'] } : {}),
          reference: typeof body['reference'] === 'string' ? body['reference'] : null,
          createdBy: who(input),
        });
        return json(200, inv);
      }
      case 'invoices.writeoff': {
        if (!board) return bad('Only the board can write off an invoice', 403);
        const inv = await writeOffInvoice(l, companyId, id, {
          ...(typeof body['occurredAt'] === 'string' ? { occurredAt: body['occurredAt'] } : {}),
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
          createdBy: who(input),
        });
        return json(200, inv);
      }
      case 'periods.list':
        return json(200, { companyId, periods: await listPeriods(l, companyId) });
      case 'periods.create': {
        if (!board) return bad('Only the board can create periods', 403);
        if (typeof body['month'] === 'string') return json(201, await ensureMonth(l, companyId, body['month']));
        return json(201, await createPeriod(l, companyId, { startsOn: String(body['startsOn'] ?? ''), endsOn: String(body['endsOn'] ?? '') }));
      }
      case 'periods.close': {
        if (!board) return bad('Only the board can close a period', 403);
        return json(200, await closePeriod(l, companyId, id, who(input)));
      }
      case 'reports.pnl': {
        const q = input.query;
        const groupRaw = str(q['groupBy']);
        const groupBy = groupRaw === 'agent' || groupRaw === 'project' || groupRaw === 'goal' ? (groupRaw as GroupBy) : null;
        const periodId = str(q['periodId']);
        let from = str(q['from']);
        let to = str(q['to']);
        if (periodId) {
          const p = await getPeriod(l, companyId, periodId);
          if (!p) return bad('Period not found', 404);
          from = `${p.startsOn}T00:00:00.000Z`;
          to = `${p.endsOn}T23:59:59.999Z`;
        }
        if (!from || !to) {
          const now = new Date();
          from = from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
          to = to ?? now.toISOString();
        }
        return json(200, await profitAndLoss(l, companyId, { from, to }, groupBy));
      }
      case 'reports.balance-sheet': {
        const asOf = str(input.query['asOf']);
        return json(200, await balanceSheet(l, companyId, asOf ?? new Date()));
      }
      case 'invoices.void': {
        if (!board) return bad('Only the board can void an invoice', 403);
        return json(200, await voidInvoice(l, companyId, id));
      }
      default:
        return bad(`Unknown route ${input.routeKey}`, 404);
    }
  } catch (err) {
    if (err instanceof LedgerError) return bad(err.message, err.code === 'period_closed' ? 409 : 400);
    if (err instanceof RangeError || err instanceof TypeError) return bad(err.message, 400);
    throw err;
  }
}

const plugin = definePlugin({
  async setup(context) {
    ctx = context;
    db = { sql: context.db, schema: context.db.namespace, posting: 'statements' };
    context.jobs.register(SWEEP_JOB, async (job) => {
      context.logger.info('ledger: sweep starting', { runId: job.runId, trigger: job.trigger });
      await sweepAll();
    });
    // Data providers for the page. The host injects the company it has
    // authorised as params.companyId, overriding anything the page sent.
    const companyOf = async (params: Record<string, unknown>): Promise<string> => {
      const companyId = typeof params['companyId'] === 'string' ? params['companyId'] : null;
      if (!companyId) throw new Error('companyId is required');
      await seedAccounts(ledger(), companyId, CURRENCY);
      return companyId;
    };
    const s = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);
    context.data.register('position', async (params) => position(ledger(), await companyOf(params)));
    context.data.register('transactions', async (params) => {
      const companyId = await companyOf(params);
      const limit = Number(params['limit'] ?? 100);
      return { companyId, transactions: await listTransactions(ledger(), companyId, { limit: Number.isFinite(limit) ? limit : 100, ...(s(params['agentRef']) ? { agentRef: s(params['agentRef'])! } : {}) }) };
    });
    context.data.register('invoices', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, invoices: await listInvoices(ledger(), companyId, { limit: 200 }) };
    });
    context.data.register('customers', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, customers: await listCustomers(ledger(), companyId) };
    });
    const httpFetch = (url: string, init?: RequestInit) => context.http.fetch(url, init);
    context.data.register('invoice', async (params) => {
      const companyId = await companyOf(params);
      let inv = await getInvoice(ledger(), companyId, String(params['invoiceId'] ?? ''));
      if (!inv) throw new Error('Invoice not found');
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      let sender: { email: string; via: string } | null | undefined;
      if (inv.hosted && isConnected(settings)) {
        try {
          const st = await hostedStatus(httpFetch, settings, companyId, inv.hosted.token);
          sender = st.sender ?? null;
          if (st.openedAt && (!inv.hosted.openedAt || st.openCount !== inv.hosted.openCount)) {
            await markInvoiceOpened(ledger(), companyId, inv.id, st.openedAt, st.openCount);
            inv = (await getInvoice(ledger(), companyId, inv.id)) ?? inv;
          }
        } catch { /* offline: show what we have */ }
      }
      return { ...inv, connected: isConnected(settings), sender: sender ?? null };
    });
    // Who the company is, for report headers. Cached for the worker's life.
    const companyNames = new Map<string, string>();
    context.data.register('company', async (params) => {
      const companyId = await companyOf(params);
      if (!companyNames.has(companyId)) {
        const all = await context.companies.list({ limit: 500 });
        for (const c of all) companyNames.set(c.id, c.name);
      }
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      return { companyId, name: companyNames.get(companyId) ?? 'Company', currency: settings.baseCurrency, settings };
    });
    // Exchange rate for a day: ECB via Frankfurter for fiat, CoinGecko for crypto. The person can still overwrite it.
    context.data.register('fx-rate', async (params) => {
      await companyOf(params);
      const from = s(params['from']);
      const to = s(params['to']);
      if (!from || !to) throw new Error('from and to are required');
      return getRate((url, init) => context.http.fetch(url, init), from, to, s(params['date']));
    });
    context.data.register('settings', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, settings: await getSettings(ledger(), companyId, CURRENCY), paymentMethods: await listPaymentMethods(ledger(), companyId) };
    });
    context.data.register('payment-methods', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, paymentMethods: await listPaymentMethods(ledger(), companyId, { enabledOnly: params['enabledOnly'] === true }) };
    });
    context.data.register('periods', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, periods: await listPeriods(ledger(), companyId) };
    });
    context.data.register('pnl', async (params) => {
      const companyId = await companyOf(params);
      const g = s(params['groupBy']);
      const groupBy = g === 'agent' || g === 'project' || g === 'goal' ? (g as GroupBy) : null;
      let from = s(params['from']);
      let to = s(params['to']);
      const periodId = s(params['periodId']);
      if (periodId) {
        const p = await getPeriod(ledger(), companyId, periodId);
        if (!p) throw new Error('Period not found');
        from = `${p.startsOn}T00:00:00.000Z`;
        to = `${p.endsOn}T23:59:59.999Z`;
      }
      const now = new Date();
      return profitAndLoss(ledger(), companyId, { from: from ?? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString(), to: to ?? now.toISOString() }, groupBy);
    });
    context.data.register('balance-sheet', async (params) => balanceSheet(ledger(), await companyOf(params), s(params['asOf']) ?? new Date()));

    // Banks and reconciliation
    context.data.register('bank-accounts', async (params) => {
      const companyId = await companyOf(params);
      const accounts = await listBankAccounts(ledger(), companyId);
      const runs = await Promise.all(accounts.map((b) => lastRun(ledger(), companyId, b.id)));
      return { companyId, accounts: accounts.map((b, i) => ({ ...b, lastRun: runs[i] })) };
    });
    context.data.register('statement-lines', async (params) => {
      const companyId = await companyOf(params);
      const bankAccountId = String(params['bankAccountId'] ?? '');
      const status = s(params['status']);
      const lines = await listStatementLines(ledger(), companyId, bankAccountId, { ...(status ? { status: status as 'all' } : {}), limit: Number(params['limit'] ?? 300) });
      return { companyId, bankAccountId, lines };
    });
    // The queue: every open line with a proposal. Lines without one get proposed now.
    context.data.register('reconcile-queue', async (params) => {
      const companyId = await companyOf(params);
      const bankAccountId = String(params['bankAccountId'] ?? '');
      const bank = await getBankAccount(ledger(), companyId, bankAccountId);
      if (!bank) throw new Error('Bank account not found');
      const lines = await listStatementLines(ledger(), companyId, bankAccountId, { status: 'unreconciled', limit: 500 });
      const out = [];
      for (const line of lines) {
        let p = line.proposal;
        if (!p) {
          p = await propose(ledger(), companyId, line);
          await saveProposal(ledger(), companyId, line.id, p);
        }
        out.push({ ...line, proposal: p });
      }
      const reconciled = await listStatementLines(ledger(), companyId, bankAccountId, { status: 'all', limit: 500 });
      return { companyId, bank, queue: out, recent: reconciled.filter((l) => l.status !== 'unreconciled').slice(0, 50), lastRun: await lastRun(ledger(), companyId, bankAccountId) };
    });
    context.data.register('bank-rules', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, rules: await listRules(ledger(), companyId) };
    });

    // Actions from the page. The board (a signed-in person) only; the host
    // tells us who is calling.
    const boardOnly = (ctx: { actor: { type: string; userId: string | null } }): string => {
      if (ctx.actor.type !== 'user') throw new Error('Only the board can do that');
      return ctx.actor.userId ?? 'board';
    };
    const amountOf = (v: unknown): bigint => {
      const n = toMinor(v);
      if (n <= 0n) throw new Error('amount must be positive');
      return n;
    };
    context.actions.register('sweep', async (params, ctx) => {
      boardOnly(ctx);
      return sweepCompany(await companyOf(params));
    });
    context.actions.register('funding', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      const amount = amountOf(params['amountMinor']);
      return postTransaction(ledger(), {
        companyId,
        occurredAt: s(params['occurredAt']) ?? new Date().toISOString(),
        description: s(params['description']) ?? 'Funding',
        sourcePlatform: 'manual',
        sourceKind: 'funding',
        sourceRef: s(params['reference']) ?? null,
        currency: CURRENCY,
        createdBy: by,
        entries: [
          { accountCode: ACCOUNT.TREASURY, direction: 'debit', amountMinor: amount },
          { accountCode: ACCOUNT.CONTRIBUTED_FUNDS, direction: 'credit', amountMinor: amount },
        ],
      });
    });
    context.actions.register('customer.create', async (params, ctx) => {
      boardOnly(ctx);
      return createCustomer(ledger(), await companyOf(params), { name: String(params['name'] ?? ''), email: s(params['email']) ?? null });
    });
    context.actions.register('invoice.create', async (params, ctx) => {
      const by = boardOnly(ctx);
      const lines = Array.isArray(params['lines']) ? (params['lines'] as Array<Record<string, unknown>>) : [];
      const companyId = await companyOf(params);
      return createInvoice(ledger(), companyId, {
        customerId: String(params['customerId'] ?? ''),
        createdBy: by,
        dueAt: s(params['dueAt']) ?? null,
        currency: s(params['currency']) ?? (await getSettings(ledger(), companyId, CURRENCY)).baseCurrency,
        rateToBase: s(params['rateToBase']) ?? null,
        paymentMethodIds: Array.isArray(params['paymentMethodIds']) ? (params['paymentMethodIds'] as string[]).map(String) : null,
        notes: s(params['notes']) ?? null,
        lines: lines.map((x) => ({ description: String(x['description'] ?? ''), quantity: typeof x['quantity'] === 'number' || typeof x['quantity'] === 'string' ? x['quantity'] : 1, unitAmountMinor: String(x['unitAmountMinor'] ?? '') })),
      });
    });
    context.actions.register('invoice.issue', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      const inv = await issueInvoice(ledger(), companyId, String(params['invoiceId'] ?? ''), { createdBy: by, ...(s(params['issuedAt']) ? { issuedAt: s(params['issuedAt'])! } : {}) });
      // A connected company gets its page the moment the invoice is issued.
      try {
        const settings = await getSettings(ledger(), companyId, CURRENCY);
        if (isConnected(settings) && !inv.hosted) await publish(companyId, inv.id);
      } catch (err) {
        context.logger.warn('ledger: hosted page not created', { invoiceId: inv.id, error: err instanceof Error ? err.message : String(err) });
      }
      return (await getInvoice(ledger(), companyId, inv.id)) ?? inv;
    });
    context.actions.register('invoice.payment', async (params, ctx) => {
      const by = boardOnly(ctx);
      return recordPayment(ledger(), await companyOf(params), String(params['invoiceId'] ?? ''), {
        amountMinor: amountOf(params['amountMinor']),
        reference: s(params['reference']) ?? null,
        createdBy: by,
        rateToBase: s(params['rateToBase']) ?? null,
        ...(s(params['occurredAt']) ? { occurredAt: s(params['occurredAt'])! } : {}),
      });
    });
    context.actions.register('invoice.set-payment-methods', async (params, ctx) => {
      boardOnly(ctx);
      const ids = Array.isArray(params['paymentMethodIds']) ? (params['paymentMethodIds'] as string[]).map(String) : null;
      return setInvoicePaymentMethods(ledger(), await companyOf(params), String(params['invoiceId'] ?? ''), ids);
    });
    // Settings and payment options
    context.actions.register('settings.update', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const pick = (k: string) => (typeof params[k] === 'string' ? (params[k] as string) : undefined);
      return updateSettings(ledger(), companyId, {
        ...(pick('baseCurrency') ? { baseCurrency: pick('baseCurrency')!.toUpperCase() } : {}),
        ...(params['legalName'] !== undefined ? { legalName: pick('legalName') ?? null } : {}),
        ...(params['address'] !== undefined ? { address: pick('address') ?? null } : {}),
        ...(params['email'] !== undefined ? { email: pick('email') ?? null } : {}),
        ...(params['taxId'] !== undefined ? { taxId: pick('taxId') ?? null } : {}),
        ...(params['invoiceFooter'] !== undefined ? { invoiceFooter: pick('invoiceFooter') ?? null } : {}),
        ...(params['replyTo'] !== undefined ? { replyTo: pick('replyTo') ?? null } : {}),
        ...(params['ai3Key'] !== undefined ? { ai3Key: pick('ai3Key') ?? null } : {}),
        ...(params['ai3Origin'] !== undefined ? { ai3Origin: pick('ai3Origin') ?? null } : {}),
      });
    });
    // Hosted invoice pages on ai3.co and sending
    const publish = async (companyId: string, invoiceId: string) => {
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      if (!isConnected(settings)) throw new Ai3Error('Not connected to ai3.co. Add the company key under Finance › Settings.');
      const inv = await getInvoice(ledger(), companyId, invoiceId);
      if (!inv) throw new Error('Invoice not found');
      if (inv.status === 'draft' || inv.status === 'void') throw new Error('Issue the invoice before publishing it');
      if (!companyNames.has(companyId)) {
        for (const c of await context.companies.list({ limit: 500 })) companyNames.set(c.id, c.name);
      }
      const r = await publishInvoice(httpFetch, settings, inv, companyNames.get(companyId) ?? 'Company');
      await setInvoiceHosted(ledger(), companyId, invoiceId, r);
      return { ...r, settings };
    };
    context.actions.register('invoice.publish', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const r = await publish(companyId, String(params['invoiceId'] ?? ''));
      return { token: r.token, url: r.url };
    });
    context.actions.register('invoice.send', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const invoiceId = String(params['invoiceId'] ?? '');
      const to = String(params['to'] ?? '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(to)) throw new Error('A valid recipient email is required');
      const r = await publish(companyId, invoiceId);
      const sent = await sendInvoice(httpFetch, r.settings, { companyId, token: r.token, to, cc: s(params['cc']) ?? null, subject: s(params['subject']) ?? null, message: s(params['message']) ?? null, replyTo: r.settings.replyTo ?? r.settings.email ?? null });
      await markInvoiceSent(ledger(), companyId, invoiceId, to);
      return { ...sent, url: r.url };
    });
    context.actions.register('invoice.revoke-link', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const inv = await getInvoice(ledger(), companyId, String(params['invoiceId'] ?? ''));
      if (!inv?.hosted) throw new Error('This invoice has no hosted page');
      await revokeInvoice(httpFetch, await getSettings(ledger(), companyId, CURRENCY), companyId, inv.hosted.token);
      return { ok: true };
    });
    context.actions.register('payment-method.create', async (params, ctx) => {
      boardOnly(ctx);
      return createPaymentMethod(ledger(), await companyOf(params), {
        kind: String(params['kind'] ?? 'other') as PaymentKind,
        label: String(params['label'] ?? ''),
        currency: s(params['currency']) ? s(params['currency'])!.toUpperCase() : null,
        details: params['details'],
        isDefault: params['isDefault'] !== false,
      });
    });
    context.actions.register('payment-method.update', async (params, ctx) => {
      boardOnly(ctx);
      return updatePaymentMethod(ledger(), await companyOf(params), String(params['id'] ?? ''), {
        ...(typeof params['label'] === 'string' ? { label: params['label'] as string } : {}),
        ...(typeof params['enabled'] === 'boolean' ? { enabled: params['enabled'] as boolean } : {}),
        ...(typeof params['isDefault'] === 'boolean' ? { isDefault: params['isDefault'] as boolean } : {}),
        ...(params['details'] !== undefined ? { details: params['details'] } : {}),
        ...(params['currency'] !== undefined ? { currency: s(params['currency']) ? s(params['currency'])!.toUpperCase() : null } : {}),
      });
    });
    context.actions.register('invoice.void', async (params, ctx) => {
      boardOnly(ctx);
      return voidInvoice(ledger(), await companyOf(params), String(params['invoiceId'] ?? ''));
    });
    context.actions.register('invoice.writeoff', async (params, ctx) => {
      const by = boardOnly(ctx);
      return writeOffInvoice(ledger(), await companyOf(params), String(params['invoiceId'] ?? ''), { createdBy: by });
    });
    context.actions.register('period.create', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const month = s(params['month']);
      return month ? ensureMonth(ledger(), companyId, month) : createPeriod(ledger(), companyId, { startsOn: String(params['startsOn'] ?? ''), endsOn: String(params['endsOn'] ?? '') });
    });
    context.actions.register('period.close', async (params, ctx) => {
      const by = boardOnly(ctx);
      return closePeriod(ledger(), await companyOf(params), String(params['periodId'] ?? ''), by);
    });

    // Banks and reconciliation
    context.data.register('feed-institutions', async (params) => {
      await companyOf(params);
      return { institutions: searchInstitutions(s(params['query']) ?? '', s(params['country']) ?? 'US').slice(0, 30), providers: ['plaid', 'truelayer', 'gocardless', 'stripe'] };
    });
    // Create from the catalogue (Xero's "Select your account") or by hand. Feeds
    // that need provider credentials the host does not have yet are created as
    // pending: the account exists, uploads work, the feed says what it waits for.
    context.actions.register('bank.create', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const inst = s(params['institutionId']) ? FEED_INSTITUTIONS.find((i) => i.id === s(params['institutionId'])) : undefined;
      const kind = (inst?.kind ?? (s(params['kind']) as BankKind | undefined)) ?? 'bank';
      const provider = inst?.provider ?? 'upload';
      const feed = provider === 'upload' ? 'upload' : provider === 'stripe' ? 'stripe' : 'aggregator';
      const account = await createBankAccount(ledger(), companyId, {
        name: s(params['name']) ?? inst?.name ?? 'Bank account', kind, currency: s(params['currency']) ?? CURRENCY, feed,
        externalRef: inst ? `${provider}:${inst.id}` : null,
      });
      const feedStatus = feed === 'upload' ? 'upload' : feed === 'stripe' ? 'needs a restricted Stripe key' : `needs ${provider} credentials on this host`;
      return { ...account, feedStatus };
    });
    // Upload: the page sends the file's text. Read it, import, propose for every new line, post nothing.
    context.actions.register('bank.import', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const bankAccountId = String(params['bankAccountId'] ?? '');
      const content = String(params['content'] ?? '');
      if (content.length > 2_000_000) throw new Error('Statement files up to 2 MB');
      const parsed = parseStatement(content, s(params['filename']) ?? '');
      const result = await importStatementLines(ledger(), companyId, bankAccountId, parsed.lines);
      const run = await runReconciliation(ledger(), companyId, bankAccountId, { autoPost: false, by: 'upload' });
      return { ...result, reading: parsed.reading, warnings: parsed.warnings, closingBalanceMinor: parsed.closingBalanceMinor === undefined ? null : String(parsed.closingBalanceMinor), proposed: run.linesSeen };
    });
    // Accept the proposal as it stands, or carry out a decision the person chose.
    context.actions.register('reconcile.apply', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      const lineId = String(params['lineId'] ?? '');
      let decision: (Decision & { invoiceId?: string; reason?: string }) | null = null;
      if (params['accept'] === true) {
        const line = await getStatementLine(ledger(), companyId, lineId);
        if (!line) throw new Error('Line not found');
        const p = line.proposal ?? (await propose(ledger(), companyId, line));
        decision = decisionOf(p);
      } else if (params['decision'] && typeof params['decision'] === 'object') {
        decision = params['decision'] as Decision & { invoiceId?: string; reason?: string };
      }
      if (!decision) throw new Error('accept: true or a decision is required');
      return applyDecision(ledger(), companyId, lineId, decision, by);
    });
    context.actions.register('reconcile.run', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      const threshold = Number(params['threshold'] ?? 90);
      return runReconciliation(ledger(), companyId, String(params['bankAccountId'] ?? ''), { threshold: Number.isFinite(threshold) ? threshold : 90, by: `board:${by}`, autoPost: params['autoPost'] !== false });
    });
    context.actions.register('rule.toggle', async (params, ctx) => {
      boardOnly(ctx);
      await setRuleEnabled(ledger(), await companyOf(params), String(params['ruleId'] ?? ''), params['enabled'] !== false);
      return { ok: true };
    });

    // Nightly: reconcile every account of every company above the threshold.
    context.jobs.register('reconcile', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let posted = 0;
      for (const company of companies) {
        try {
          for (const bank of await listBankAccounts(ledger(), company.id)) {
            const r = await runReconciliation(ledger(), company.id, bank.id, { threshold: 90, by: 'nightly' });
            posted += r.autoPosted;
          }
        } catch (err) {
          context.logger.error('ledger: nightly reconcile failed', { companyId: company.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      context.logger.info('ledger: nightly reconcile done', { runId: job.runId, posted });
    });
    context.logger.info('ledger: ready', { namespace: context.db.namespace });
  },

  async onApiRequest(input) {
    try {
      return await handle(input);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx?.logger.error('ledger: api request failed', { routeKey: input.routeKey, error: message });
      return bad(message, 500);
    }
  },

  async onHealth() {
    if (!db) return { status: 'error', message: 'not set up' };
    const errors = lastSweep?.errors.length ?? 0;
    return {
      status: errors > 0 ? 'degraded' : 'ok',
      ...(lastSweep ? { message: `last sweep ${lastSweep.at}: ${lastSweep.results.reduce((n, r) => n + r.posted, 0)} posted, ${errors} errors` } : {}),
      details: { namespace: db.schema ?? null, lastSweepAt: lastSweep?.at ?? null },
    };
  },

  async onShutdown() {
    ctx = null;
    db = null;
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
