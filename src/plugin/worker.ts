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
      return bad(`Unknown route ${input.routeKey}`, 404);
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
