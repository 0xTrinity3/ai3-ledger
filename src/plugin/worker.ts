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
  type GroupBy,
  type LedgerDb,
  type SweepResult,
} from '../core/index.js';
import { paperclipCostSource } from './cost-source.js';

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
    context.data.register('position', async (params) => {
      const companyId = typeof params['companyId'] === 'string' ? params['companyId'] : null;
      if (!companyId) throw new Error('companyId is required');
      await seedAccounts(ledger(), companyId, CURRENCY);
      return position(ledger(), companyId);
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
