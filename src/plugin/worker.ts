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
import { registerModel } from './model.js';
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
  creditInvoice,
  voidInvoice,
  type InvoiceStatus,
  listPeriods,
  createPeriod,
  ensureMonth,
  closePeriod,
  profitAndLoss,
  balanceSheet,
  trialBalanceReport,
  listEntries,
  listJournals,
  getJournal,
  createJournal,
  postJournal,
  voidJournal,
  deleteJournal,
  listSuppliers,
  createSupplier,
  listBills,
  getBill,
  createBill,
  approveBill,
  payBill,
  voidBill,
  deleteBill,
  parseChartCsv,
  importChart,
  parseTrialBalanceCsv,
  importTrialBalance,
  parseDocumentsCsv,
  previewDocuments,
  importDocuments,
  standingConversion,
  undoTrialBalance,
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
  markInvoiceReminded,
  dueReminders,
  reminderEmail,
  getWallet,
  listConnectedWallets,
  listDisputes,
  updateDispute,
  type PaymentKind,
  type Decision,
  type BankKind,
  type GroupBy,
  type LedgerDb,
  type SweepResult,
  resolveCode,
  aggregate as meterAggregate,
  balanceFor as meterBalance,
  capture as meterCapture,
  fund as meterFund,
  listBalances as meterBalances,
  listEvents as meterEvents,
  release as meterRelease,
  reserve as meterReserve,
  statement as meterStatement,
  accrue as streamAccrue,
  cancelStream,
  getStream,
  invoiceStatement,
  listStreams,
  openStream,
  pauseStream,
  tick as streamTick,
  withdraw as streamWithdraw,

} from '../core/index.js';
import { paperclipCostSource } from './cost-source.js';
import { Ai3Error, hostedStatus, isConnected, publishInvoice, revokeInvoice, sendInvoice } from './ai3.js';
import { TOOL_DECLARATIONS, runTool } from './tools.js';
import { LEDGER_SKILL_KEY } from './skill.js';
import { buildBriefing } from './briefing.js';
import { publishSummary, type IssueLike } from './publish.js';
import { PATH_USD_SYMBOL, TEMPO_NETWORK_LABEL, balanceCents, ensureWallet, explorerAddress, requestFaucet, syncWalletFeed } from './tempo.js';
import { getCase, type Ruling } from './recourse.js';
import { CHAINS, chainSummary } from './chains.js';
import { fetchCredits, syncCredits } from './credits.js';
import { billingDue, billingOpen, runMarket, ledgerEntitlement, gatedTool, notEntitledMessage, forgetEntitlements } from './market.js';
import { exchangeSummaries } from './exchanges.js';
import { bookBrowserPayment, connectAddressWallet, connectExchangeAccount, connectedWalletsView, disconnectWallet, ownershipMessage, payFromCompanyWallet, remoteInvoiceView, syncAllConnected, syncWalletForBank } from './pay.js';
import { registerBooks } from './books.js';
import { connectStripe, refreshStripe, syncStripeFeed, stripeStatus } from './stripe.js';
import { bankFeedView, syncBankFeeds } from './banks.js';
import { walletOffers, type WalletOffer } from './credits.js';
import { getStripeLink } from '../core/index.js';

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

const moduleCompanyNames = new Map<string, string>();
async function companyNameOf(companyId: string): Promise<string> {
  if (ctx && !moduleCompanyNames.has(companyId)) {
    for (const c of await ctx.companies.list({ limit: 500 })) moduleCompanyNames.set(c.id, c.name);
  }
  return moduleCompanyNames.get(companyId) ?? 'Company';
}

// Companies whose skills library already holds the ledger skill this worker
// life. Reconcile is idempotent on the host; this just saves the calls.
const skillSynced = new Set<string>();
async function syncSkill(companyId: string): Promise<void> {
  const c = ctx;
  if (!c || skillSynced.has(companyId)) return;
  try {
    const r = await c.skills.managed.reconcile(LEDGER_SKILL_KEY, companyId);
    skillSynced.add(companyId);
    if (r.status === 'created' || r.status === 'relinked') c.logger.info('ledger: skill installed', { companyId, status: r.status });
  } catch (err) {
    c.logger.warn('ledger: skill not installed', { companyId, error: err instanceof Error ? err.message : String(err) });
  }
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
    await syncSkill(company.id);
    // The skill is reconciled either way — an agent should still be told what
    // the ledger is, and that it is not active — but nothing is swept.
    if (!(await jobAllowed(company.id, (url: string, init?: RequestInit) => c.http.fetch(url, init), 'sweep'))) continue;
    try {
      await seedAccounts(ledger(), company.id, CURRENCY);
      const w = await ensureWallet(ledger(), company.id, CURRENCY);
      if (w.created) c.logger.info('ledger: wallet created', { companyId: company.id, address: w.wallet.address, faucet: w.faucet?.ok ?? null });
    } catch (err) {
      c.logger.warn('ledger: wallet not ready', { companyId: company.id, error: err instanceof Error ? err.message : String(err) });
    }
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
      case 'invoices.credit': {
        // A credit note: the income comes back out for a stated amount, with
        // the reason on the record. Not a payment, and never posted as one.
        if (!board) return bad('Only the board can credit an invoice', 403);
        return json(200, await creditInvoice(l, companyId, id, {
          amountMinor: String(body['amountMinor'] ?? ''),
          reason: String(body['reason'] ?? ''),
          ...(typeof body['reference'] === 'string' ? { reference: body['reference'] } : {}),
          ...(typeof body['occurredAt'] === 'string' ? { occurredAt: body['occurredAt'] } : {}),
          createdBy: who(input),
        }));
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
      // M6: the agent tools over HTTP, same functions as the gateway tools.
      case 'tools.list':
        return json(200, { tools: TOOL_DECLARATIONS.map((t) => ({ name: t.name, displayName: t.displayName, description: t.description, parametersSchema: t.parametersSchema })) });
      case 'tools.invoke': {
        const name = String(input.params['name'] ?? '');
        if (!TOOL_DECLARATIONS.some((t) => t.name === name)) return bad(`Unknown tool ${name}`, 404);
        const c = ctx;
        if (!c) return bad('worker not ready', 503);
        const { companyId: _ignored, ...params } = body;
        const actor = input.actor.actorType === 'agent' && input.actor.agentId ? input.actor.agentId : `board:${input.actor.userId ?? 'user'}`;
        const started = Date.now();
        const result = await runTool(
          { db: l, fetch: (url, init) => c.http.fetch(url, init), companyName: companyNameOf, baseCurrency: CURRENCY },
          name,
          params,
          { agentId: actor, runId: '', companyId, projectId: '' },
        );
        c.logger.info('ledger: tool', { tool: name, via: 'http', actor, companyId, ms: Date.now() - started, ...(result.error ? { error: result.error } : {}) });
        return json(result.error ? 400 : 200, result);
      }
      case 'invoices.void': {
        if (!board) return bad('Only the board can void an invoice', 403);
        return json(200, await voidInvoice(l, companyId, id));
      }
      // ---- everything else a person does to these books ------------------
      //
      // Each of these wraps the same core function the plugin's own screens
      // call. They exist so that a company with a Paperclip instance can be
      // worked on from ai3.co as well as from inside Paperclip: the books are
      // one ledger, and which window you look through should not decide what
      // you are allowed to do.
      case 'reports.trial-balance': {
        const asOf = str(input.query['asOf']);
        const from = str(input.query['from']);
        return json(200, await trialBalanceReport(l, companyId, asOf ?? new Date(), from));
      }
      case 'entries': {
        const q = input.query;
        const limitRaw = Number(str(q['limit']) ?? 300);
        return json(200, await listEntries(l, companyId, {
          ...(str(q['accountCode']) ? { accountCode: String(str(q['accountCode'])) } : {}),
          ...(str(q['from']) ? { from: String(str(q['from'])) } : {}),
          ...(str(q['to']) ? { to: String(str(q['to'])) } : {}),
          ...(str(q['groupBy']) ? { groupBy: str(q['groupBy']) as 'agent' | 'project' | 'goal' } : {}),
          ...(str(q['groupKey']) ? { groupKey: String(str(q['groupKey'])) } : {}),
          withChildren: str(q['withChildren']) !== 'false',
          limit: Number.isFinite(limitRaw) ? limitRaw : 300,
        }));
      }

      case 'journals.list':
        return json(200, { companyId, journals: await listJournals(l, companyId, { limit: Number(str(input.query['limit']) ?? 200) }) });
      case 'journals.get': {
        const j = await getJournal(l, companyId, id);
        return j ? json(200, j) : bad('Journal not found', 404);
      }
      case 'journals.create': {
        if (!board) return bad('Only the board can write a journal', 403);
        return json(201, await createJournal(l, companyId, {
          occurredAt: typeof body['occurredAt'] === 'string' ? body['occurredAt'] : new Date().toISOString(),
          narration: typeof body['narration'] === 'string' ? body['narration'] : null,
          lines: Array.isArray(body['lines']) ? (body['lines'] as never[]) : [],
          post: body['post'] === true,
          createdBy: who(input),
        }));
      }
      case 'journals.post': {
        if (!board) return bad('Only the board can post a journal', 403);
        return json(200, await postJournal(l, companyId, id, { createdBy: who(input) }));
      }
      case 'journals.void': {
        if (!board) return bad('Only the board can reverse a journal', 403);
        return json(200, await voidJournal(l, companyId, id, {
          createdBy: who(input),
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
        }));
      }
      case 'journals.delete': {
        if (!board) return bad('Only the board can discard a draft', 403);
        return json(200, await deleteJournal(l, companyId, id));
      }

      case 'suppliers.list':
        return json(200, { companyId, suppliers: await listSuppliers(l, companyId) });
      case 'suppliers.create': {
        if (!board) return bad('Only the board can add a supplier', 403);
        return json(201, await createSupplier(l, companyId, {
          name: String(body['name'] ?? ''),
          email: typeof body['email'] === 'string' ? body['email'] : null,
          defaultAccountCode: typeof body['defaultAccountCode'] === 'string' ? body['defaultAccountCode'] : null,
        }));
      }
      case 'bills.list':
        return json(200, { companyId, bills: await listBills(l, companyId, { limit: Number(str(input.query['limit']) ?? 200), withLines: true }) });
      case 'bills.get': {
        const b = await getBill(l, companyId, id);
        return b ? json(200, b) : bad('Bill not found', 404);
      }
      case 'bills.create':
        return json(201, await createBill(l, companyId, {
          supplierId: String(body['supplierId'] ?? ''),
          currency: typeof body['currency'] === 'string' ? body['currency'] : CURRENCY,
          lines: Array.isArray(body['lines']) ? (body['lines'] as never[]) : [],
          ...(typeof body['issuedAt'] === 'string' ? { issuedAt: body['issuedAt'] } : {}),
          ...(typeof body['dueAt'] === 'string' ? { dueAt: body['dueAt'] } : {}),
          ...(typeof body['reference'] === 'string' ? { reference: body['reference'] } : {}),
          ...(body['subject'] && typeof body['subject'] === 'object' ? { subject: body['subject'] as never } : {}),
          createdBy: who(input),
        }));
      case 'bills.approve': {
        if (!board) return bad('Only the board can approve a bill', 403);
        return json(200, await approveBill(l, companyId, id, { createdBy: who(input) }));
      }
      case 'bills.pay': {
        if (!board) return bad('Only the board can pay a bill', 403);
        return json(200, await payBill(l, companyId, id, {
          amountMinor: body['amountMinor'] === null || body['amountMinor'] === undefined ? null : (body['amountMinor'] as string),
          ...(typeof body['occurredAt'] === 'string' ? { occurredAt: body['occurredAt'] } : {}),
          reference: typeof body['reference'] === 'string' ? body['reference'] : null,
          cashAccountCode: typeof body['cashAccountCode'] === 'string' ? body['cashAccountCode'] : null,
          createdBy: who(input),
        }));
      }
      case 'bills.void': {
        if (!board) return bad('Only the board can cancel a bill', 403);
        return json(200, await voidBill(l, companyId, id, { createdBy: who(input) }));
      }
      case 'bills.delete': {
        if (!board) return bad('Only the board can discard a draft', 403);
        return json(200, await deleteBill(l, companyId, id));
      }

      case 'banks.list':
        return json(200, { companyId, accounts: await listBankAccounts(l, companyId) });
      case 'banks.create': {
        if (!board) return bad('Only the board can add a bank account', 403);
        return json(201, await createBankAccount(l, companyId, {
          name: String(body['name'] ?? ''),
          kind: (typeof body['kind'] === 'string' ? body['kind'] : 'bank') as never,
          currency: typeof body['currency'] === 'string' ? body['currency'] : CURRENCY,
          feed: 'upload',
        }));
      }
      case 'banks.lines': {
        const status = str(input.query['status']);
        return json(200, {
          companyId,
          bankAccountId: id,
          lines: await listStatementLines(l, companyId, id, {
            ...(status ? { status: status as 'all' } : {}),
            limit: Number(str(input.query['limit']) ?? 300),
          }),
        });
      }
      case 'banks.import': {
        if (!board) return bad('Only the board can import a statement', 403);
        // The parse is separate from the import so the caller can show it back
        // before a single row reaches the books; both halves are here because
        // over HTTP there is one round trip either way.
        const text = String(body['statement'] ?? '');
        const parsed = parseStatement(text, typeof body['filename'] === 'string' ? body['filename'] : 'statement.csv',
          body['dateOrder'] === 'dmy' || body['dateOrder'] === 'mdy' ? { dateOrder: body['dateOrder'] } : {});
        if (body['preview'] === true) return json(200, { parsed });
        return json(200, { parsed, result: await importStatementLines(l, companyId, id, parsed.lines) });
      }
      case 'reconcile.run': {
        if (!board) return bad('Only the board can run reconciliation', 403);
        const settings = await getSettings(l, companyId, CURRENCY);
        const threshold = Number(body['threshold'] ?? settings.autoReconcileThreshold);
        return json(200, await runReconciliation(l, companyId, id, {
          threshold: Number.isFinite(threshold) ? threshold : settings.autoReconcileThreshold,
          by: `board:${who(input)}`,
          autoPost: body['autoPost'] === undefined ? settings.autoReconcile : body['autoPost'] !== false,
        }));
      }
      case 'reconcile.decide': {
        if (!board) return bad('Only the board can reconcile a line', 403);
        const line = await getStatementLine(l, companyId, id);
        if (!line) return bad('Statement line not found', 404);
        let decision = body['decision'] as never;
        if (body['accept'] === true) {
          const proposal = line.proposal ?? await propose(l, companyId, line);
          if (!proposal || proposal.kind === 'ask') return bad('There is nothing to accept: choose an account instead.');
          decision = decisionOf(proposal) as never;
        }
        if (!decision) return bad('A decision is required');
        return json(200, await applyDecision(l, companyId, id, decision, who(input)));
      }
      case 'reconcile.rules':
        return json(200, { companyId, rules: await listRules(l, companyId) });
      case 'reconcile.rule': {
        if (!board) return bad('Only the board can change a rule', 403);
        await setRuleEnabled(l, companyId, id, body['enabled'] !== false);
        return json(200, { ok: true });
      }

      case 'settings.get':
        return json(200, await getSettings(l, companyId, CURRENCY));
      case 'settings.update': {
        if (!board) return bad('Only the board can change these settings', 403);
        const allowed = ['legalName', 'address', 'email', 'taxId', 'invoiceFooter', 'replyTo',
          'remindersEnabled', 'leaderboardOptIn', 'autoReconcile', 'autoReconcileThreshold'] as const;
        const patch: Record<string, unknown> = {};
        for (const k of allowed) if (k in body) patch[k] = body[k];
        return json(200, await updateSettings(l, companyId, patch as never));
      }
      case 'payments.list':
        return json(200, { companyId, methods: await listPaymentMethods(l, companyId) });
      case 'payments.create': {
        if (!board) return bad('Only the board can add a payment option', 403);
        return json(201, await createPaymentMethod(l, companyId, {
          kind: (typeof body['kind'] === 'string' ? body['kind'] : 'other') as never,
          label: String(body['label'] ?? ''),
          currency: typeof body['currency'] === 'string' ? body['currency'] : null,
          details: body['details'] ?? {},
          isDefault: body['isDefault'] === true,
        }));
      }
      case 'payments.update': {
        if (!board) return bad('Only the board can change a payment option', 403);
        return json(200, await updatePaymentMethod(l, companyId, id, {
          ...(typeof body['label'] === 'string' ? { label: body['label'] } : {}),
          ...(body['enabled'] === undefined ? {} : { enabled: body['enabled'] !== false }),
          ...(body['isDefault'] === undefined ? {} : { isDefault: body['isDefault'] === true }),
          ...(body['details'] === undefined ? {} : { details: body['details'] }),
        }));
      }

      case 'import.chart': {
        if (!board) return bad('Only the board can import a chart of accounts', 403);
        const parsed = parseChartCsv(String(body['csv'] ?? ''));
        if (body['preview'] === true) return json(200, { parsed });
        return json(200, { parsed, result: await importChart(l, companyId, parsed.lines) });
      }
      case 'import.opening': {
        if (!board) return bad('Only the board can post opening balances', 403);
        const parsed = parseTrialBalanceCsv(String(body['csv'] ?? ''));
        if (body['preview'] === true) return json(200, { parsed });
        return json(200, {
          parsed,
          result: await importTrialBalance(l, companyId, {
            conversionDate: String(body['conversionDate'] ?? ''),
            lines: parsed.lines,
            createdBy: who(input),
            plugToRetainedEarnings: body['plugToRetainedEarnings'] === true,
          }),
        });
      }
      // ---- the subledger -------------------------------------------------
      //
      // The detail of what agents did, and the periodic journal that summarises
      // it. An agent may reserve, capture and release its own budget; only the
      // board funds a balance or sweeps a window into the general ledger.
      case 'meter.balances':
        return json(200, { companyId, balances: await meterBalances(l, companyId) });
      case 'meter.fund': {
        if (!board) return bad('Only the board can put money on a balance', 403);
        return json(200, await meterFund(l, companyId, {
          holder: String(body['holder'] ?? ''),
          currency: String(body['currency'] ?? 'USD'),
          amountMinor: String(body['amountMinor'] ?? '0'),
          post: body['post'] === true,
          ...(typeof body['cashAccountCode'] === 'string' ? { cashAccountCode: body['cashAccountCode'] } : {}),
          ...(typeof body['reference'] === 'string' ? { reference: body['reference'] } : {}),
          createdBy: who(input),
        }));
      }
      case 'meter.reserve': {
        // Cannot overspend: the balance refuses, which is the whole mechanism.
        return json(200, await meterReserve(l, companyId, {
          holder: String(body['holder'] ?? ''),
          currency: String(body['currency'] ?? 'USD'),
          maxMinor: String(body['maxMinor'] ?? '0'),
          ...(typeof body['kind'] === 'string' ? { kind: body['kind'] as 'usage' | 'time' | 'output' | 'outcome' } : {}),
          ...(typeof body['accountCode'] === 'string' ? { accountCode: body['accountCode'] } : {}),
          ...(typeof body['counterparty'] === 'string' ? { counterparty: body['counterparty'] } : {}),
          internal: body['internal'] === true,
          ...(typeof body['sku'] === 'string' ? { sku: body['sku'] } : {}),
          ...(typeof body['reference'] === 'string' ? { reference: body['reference'] } : {}),
          ...(body['subject'] && typeof body['subject'] === 'object' ? { subject: body['subject'] as Record<string, string> } : {}),
          createdBy: who(input),
        }));
      }
      case 'meter.capture': {
        return json(200, await meterCapture(l, companyId, String(body['id'] ?? ''), {
          amountMinor: String(body['amountMinor'] ?? '0'),
          ...(body['passThroughMinor'] === undefined ? {} : { passThroughMinor: String(body['passThroughMinor']) }),
          ...(body['quantity'] === undefined ? {} : { quantity: String(body['quantity']) }),
          ...(body['unitAmountMinor'] === undefined ? {} : { unitAmountMinor: String(body['unitAmountMinor']) }),
        }));
      }
      case 'meter.release':
        return json(200, await meterRelease(l, companyId, String(body['id'] ?? '')));
      case 'meter.events':
        return json(200, {
          companyId,
          events: await meterEvents(l, companyId, {
            ...(input.query['holder'] ? { holder: String(input.query['holder']) } : {}),
            ...(input.query['from'] ? { from: String(input.query['from']) } : {}),
            ...(input.query['to'] ? { to: String(input.query['to']) } : {}),
            ...(input.query['status'] ? { status: String(input.query['status']) as 'reserved' | 'captured' | 'released' | 'void' } : {}),
            ...(input.query['limit'] ? { limit: Number(input.query['limit']) } : {}),
          }),
        });
      case 'meter.aggregate': {
        if (!board) return bad('Only the board can post the subledger to the general ledger', 403);
        return json(200, await meterAggregate(l, companyId, {
          from: String(body['from'] ?? ''),
          to: String(body['to'] ?? ''),
          ...(typeof body['currency'] === 'string' ? { currency: body['currency'] } : {}),
          createdBy: who(input),
        }));
      }
      case 'meter.statement':
        return json(200, await meterStatement(l, companyId, {
          holder: String(input.query['holder'] ?? ''),
          currency: String(input.query['currency'] ?? 'USD'),
          from: String(input.query['from'] ?? ''),
          to: String(input.query['to'] ?? ''),
        }));

      case 'meter.invoice': {
        if (!board) return bad('Only the board can issue a statement invoice', 403);
        return json(200, await invoiceStatement(l, companyId, {
          holder: String(body['holder'] ?? ''),
          customerId: String(body['customerId'] ?? ''),
          currency: String(body['currency'] ?? 'USD'),
          from: String(body['from'] ?? ''),
          to: String(body['to'] ?? ''),
          prepaid: body['prepaid'] === true,
          ...(typeof body['dueAt'] === 'string' ? { dueAt: body['dueAt'] } : {}),
          createdBy: who(input),
        }));
      }

      // ---- streams ---------------------------------------------------------
      //
      // An agent may earn against a stream somebody opened for it — accruing
      // and ticking are the work reporting itself — but only the board opens
      // one, stops one, or moves money out of it.
      case 'streams.list':
        return json(200, {
          companyId,
          streams: await listStreams(l, companyId, {
            ...(input.query['recipient'] ? { recipient: String(input.query['recipient']) } : {}),
            ...(input.query['payer'] ? { payer: String(input.query['payer']) } : {}),
            ...(input.query['status'] ? { status: String(input.query['status']) as 'active' | 'paused' | 'cancelled' | 'ended' } : {}),
          }),
        });
      case 'streams.open': {
        if (!board) return bad('Only the board can open a stream', 403);
        return json(200, await openStream(l, companyId, {
          payer: String(body['payer'] ?? ''),
          recipient: String(body['recipient'] ?? ''),
          kind: String(body['kind'] ?? 'usage') as 'usage' | 'time' | 'output' | 'outcome',
          meter: String(body['meter'] ?? ''),
          currency: String(body['currency'] ?? 'USD'),
          ...(body['rateMinor'] === undefined ? {} : { rateMinor: String(body['rateMinor']) }),
          ...(body['ratePct'] === undefined ? {} : { ratePct: Number(body['ratePct']) }),
          capMinor: String(body['capMinor'] ?? '0'),
          ...(typeof body['capPeriod'] === 'string' ? { capPeriod: body['capPeriod'] as 'total' | 'day' | 'month' } : {}),
          ...(typeof body['accountCode'] === 'string' ? { accountCode: body['accountCode'] } : {}),
          internal: body['internal'] === true,
          ...(body['noticeSeconds'] === undefined ? {} : { noticeSeconds: Number(body['noticeSeconds']) }),
          createdBy: who(input),
        }));
      }
      case 'streams.accrue':
        return json(200, await streamAccrue(l, companyId, id, {
          ...(body['quantity'] === undefined ? {} : { quantity: String(body['quantity']) }),
          ...(body['valueMinor'] === undefined ? {} : { valueMinor: String(body['valueMinor']) }),
          ...(typeof body['reference'] === 'string' ? { reference: body['reference'] } : {}),
          createdBy: who(input),
        }));
      case 'streams.tick':
        return json(200, await streamTick(l, companyId, id, { createdBy: who(input) }));
      case 'streams.pause': {
        if (!board) return bad('Only the board can pause a stream', 403);
        return json(200, await pauseStream(l, companyId, id));
      }
      case 'streams.cancel': {
        if (!board) return bad('Only the board can cancel a stream', 403);
        return json(200, await cancelStream(l, companyId, id, {
          ...(typeof body['reason'] === 'string' ? { reason: body['reason'] } : {}),
          immediate: body['immediate'] === true,
        }));
      }
      case 'streams.withdraw': {
        if (!board) return bad('Only the board can settle a stream', 403);
        return json(200, await streamWithdraw(l, companyId, id, {
          ...(body['amountMinor'] === undefined ? {} : { amountMinor: String(body['amountMinor']) }),
          ...(typeof body['cashAccountCode'] === 'string' ? { cashAccountCode: body['cashAccountCode'] } : {}),
          createdBy: who(input),
        }));
      }

      case 'import.documents': {
        // Invoices and bills out of a spreadsheet, on the same read → show →
        // apply path as the chart and the opening balances. A preview writes
        // nothing, which is what lets the site render the rows and the control
        // account difference before anybody commits to them.
        if (!board) return bad('Only the board can import invoices and bills', 403);
        const kind = body['kind'] === 'bill' ? 'bill' : 'invoice';
        const parsed = parseDocumentsCsv(String(body['csv'] ?? ''), kind, {});
        const conversionDate = body['conversionDate'] ? String(body['conversionDate']) : null;
        const preview = await previewDocuments(l, companyId, parsed, { conversionDate });
        if (body['preview'] === true) return json(200, { parsed, preview });
        return json(200, {
          parsed,
          preview,
          result: await importDocuments(l, companyId, parsed, {
            conversionDate,
            cashAccountCode: body['cashAccountCode'] ? String(body['cashAccountCode']) : null,
            defaultAccountCode: body['defaultAccountCode'] ? String(body['defaultAccountCode']) : null,
            createdBy: who(input),
          }),
        });
      }
      case 'import.standing':
        return json(200, { companyId, standing: await standingConversion(l, companyId) });
      case 'import.undo': {
        if (!board) return bad('Only the board can reverse opening balances', 403);
        return json(200, { reversed: await undoTrialBalance(l, companyId, { createdBy: who(input) }) });
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

/**
 * Should a scheduled job run for this company?
 *
 * The automation is what a company pays for, so it is what stops when it does
 * not. The books it has already built stay readable and payable either way —
 * they simply stop keeping themselves up to date, which is a state a company can
 * live in and recover from.
 */
async function jobAllowed(companyId: string, httpFetch: (url: string, init?: RequestInit) => Promise<Response>, job: string): Promise<boolean> {
  try {
    const e = await ledgerEntitlement(httpFetch, await getSettings(ledger(), companyId, CURRENCY), companyId);
    if (!e.ok) ctx?.logger.info('ledger: job skipped, not entitled', { job, companyId, reason: e.reason });
    return e.ok;
  } catch {
    // The guard must never be the reason a job fails to run.
    return true;
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
      let hostedPayments: NonNullable<Awaited<ReturnType<typeof hostedStatus>>['payments']> = [];
      if (inv.hosted && isConnected(settings)) {
        try {
          const st = await hostedStatus(httpFetch, settings, companyId, inv.hosted.token);
          sender = st.sender ?? null;
          hostedPayments = st.payments ?? [];
          if (st.openedAt && (!inv.hosted.openedAt || st.openCount !== inv.hosted.openCount)) {
            await markInvoiceOpened(ledger(), companyId, inv.id, st.openedAt, st.openCount);
            inv = (await getInvoice(ledger(), companyId, inv.id)) ?? inv;
          }
        } catch { /* offline: show what we have */ }
      }
      return { ...inv, connected: isConnected(settings), sender: sender ?? null, hostedPayments };
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
      return {
        companyId, bank, queue: out,
        recent: reconciled.filter((l) => l.status !== 'unreconciled').slice(0, 50),
        lastRun: await lastRun(ledger(), companyId, bankAccountId),
      };
    });
    context.data.register('bank-rules', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, rules: await listRules(ledger(), companyId) };
    });
    /**
     * What the matcher is allowed to do on its own, and what it has learned.
     *
     * Both existed and neither was visible: the threshold was a constant in the
     * nightly job, and the rules it learns from confirmations could be listed
     * by this plugin but were shown on no screen. A rule that posts to somebody's
     * books unattended and cannot be seen or switched off is the wrong kind of
     * automation, however good its hit rate.
     */
    context.data.register('reconcile-settings', async (params) => {
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId);
      return {
        companyId,
        auto: { enabled: settings.autoReconcile, threshold: settings.autoReconcileThreshold },
        rules: await listRules(ledger(), companyId),
      };
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
        ...(params['remindersEnabled'] !== undefined ? { remindersEnabled: params['remindersEnabled'] === true } : {}),
        ...(params['leaderboardOptIn'] !== undefined ? { leaderboardOptIn: params['leaderboardOptIn'] === true } : {}),
      });
    });
    // Settings › Model: the organisation's default model, relayed to ai3.co.
    registerModel(context, { fetch: httpFetch, companyOf, settingsOf: (companyId) => getSettings(ledger(), companyId, CURRENCY), boardOnly });
    // Push this company's figures to ai3.co now (the daily job does the same for every company).
    const issuesFor = async (companyId: string): Promise<IssueLike[] | null> => {
      try {
        const issues = await context.issues.list({ companyId, limit: 500 });
        return issues.map((i) => ({ status: String(i.status), updatedAt: String(i.updatedAt) }));
      } catch {
        return null;
      }
    };
    context.actions.register('summary.publish', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      await seedAccounts(ledger(), companyId, CURRENCY);
      const r = await publishSummary(ledger(), httpFetch, { companyId, companyName: await nameOf(companyId), issues: await issuesFor(companyId), baseCurrency: CURRENCY });
      if (!r.published) throw new Error('Not connected to ai3.co. Add the company key under Finance › Settings.');
      return { published: true, leaderboardOptIn: r.payload?.leaderboardOptIn ?? false, asOf: r.payload?.summary.asOf ?? null };
    });
    // Marketplace: invoice for the agents this company sells, report collections,
    // and — when this is the platform company — bill developers their commission.
    const marketDeps = (companyId: string) => ({ db: ledger(), fetch: httpFetch, companyName: companyNameOf, baseCurrency: CURRENCY, companyId });
    context.data.register('market', async (params) => {
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      if (!isConnected(settings)) return { connected: false, due: [], open: [] };
      let due: unknown[] = [];
      let open: unknown[] = [];
      let error: string | null = null;
      try {
        due = await billingDue(httpFetch, settings, companyId);
        open = await billingOpen(httpFetch, settings, companyId);
      } catch (err) { error = err instanceof Error ? err.message : String(err); }
      return { connected: true, due, open, error };
    });
    context.actions.register('market.run', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const { companyId: _drop, ...deps } = marketDeps(companyId);
      return runMarket(deps, companyId);
    });
    context.jobs.register('market', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let invoiced = 0;
      let collected = 0;
      let commission = 0;
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'market'))) continue;
        try {
          const { companyId: _drop, ...deps } = marketDeps(company.id);
          const r = await runMarket(deps, company.id);
          invoiced += r.invoiced.length;
          collected += r.collected.length;
          commission += r.commission.length;
          for (const f of r.failures) failures.push(`${company.name}: ${f}`);
        } catch (err) {
          failures.push(`${company.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      context.logger.info('ledger: market billing done', { runId: job.runId, invoiced, collected, commission, failed: failures.length });
      if (failures.length > 0) throw new Error(`market: ${failures.join('; ')}`.slice(0, 1000));
    });
    context.jobs.register('publish', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let published = 0;
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'publish'))) continue;
        try {
          await seedAccounts(ledger(), company.id, CURRENCY);
          const r = await publishSummary(ledger(), httpFetch, { companyId: company.id, companyName: company.name, issues: await issuesFor(company.id), baseCurrency: CURRENCY });
          if (r.published) published += 1;
        } catch (err) {
          failures.push(`${company.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      context.logger.info('ledger: publish done', { runId: job.runId, published, failed: failures.length });
      if (failures.length > 0) throw new Error(`summary not published: ${failures.join('; ')}`.slice(0, 1000));
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
      return { institutions: searchInstitutions(s(params['query']) ?? '', s(params['country']) ?? 'US').slice(0, 30), providers: ['plaid', 'gocardless', 'stripe'] };
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
    context.actions.register('reconcile.settings', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const enabled = params['enabled'] !== false;
      const threshold = Number(params['threshold']);
      const saved = await updateSettings(ledger(), companyId, {
        autoReconcile: enabled,
        ...(Number.isFinite(threshold) ? { autoReconcileThreshold: threshold } : {}),
      });
      return { enabled: saved.autoReconcile, threshold: saved.autoReconcileThreshold };
    });
    context.actions.register('rule.toggle', async (params, ctx) => {
      boardOnly(ctx);
      await setRuleEnabled(ledger(), await companyOf(params), String(params['ruleId'] ?? ''), params['enabled'] !== false);
      return { ok: true };
    });

    // Nightly: reconcile every account of every company that asked for it.
    //
    // The threshold used to be 90 here, in our source, for everybody — a policy
    // about a stranger's books that they could neither see nor change. It comes
    // off their own settings now, and a company that has turned auto-posting off
    // is skipped entirely: the proposals are still computed, so the queue is
    // ready in the morning, but nothing reaches the books without a person.
    context.jobs.register('reconcile', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let posted = 0;
      let proposedOnly = 0;
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'reconcile'))) continue;
        try {
          const settings = await getSettings(ledger(), company.id);
          for (const bank of await listBankAccounts(ledger(), company.id)) {
            const r = await runReconciliation(ledger(), company.id, bank.id, {
              threshold: settings.autoReconcileThreshold,
              by: 'nightly',
              autoPost: settings.autoReconcile,
            });
            posted += r.autoPosted;
            if (!settings.autoReconcile) proposedOnly += r.leftForReview;
          }
        } catch (err) {
          context.logger.error('ledger: nightly reconcile failed', { companyId: company.id, error: err instanceof Error ? err.message : String(err) });
        }
      }
      context.logger.info('ledger: nightly reconcile done', { runId: job.runId, posted, proposedOnly });
    });

    // M6: agent tools. The host validates params against the manifest schema
    // and supplies the agent, run and company; the tool never trusts a
    // company from the caller.
    const nameOf = async (companyId: string): Promise<string> => {
      if (!companyNames.has(companyId)) {
        for (const c of await context.companies.list({ limit: 500 })) companyNames.set(c.id, c.name);
      }
      return companyNames.get(companyId) ?? 'Company';
    };
    for (const decl of TOOL_DECLARATIONS) {
      context.tools.register(decl.name, { displayName: decl.displayName, description: decl.description, parametersSchema: decl.parametersSchema }, async (params, runCtx) => {
        await seedAccounts(ledger(), runCtx.companyId, CURRENCY);
        // Reading the books, paying what you owe and filing a dispute are never
        // gated; everything that creates new work or new obligations is.
        if (gatedTool(decl.name)) {
          const e = await ledgerEntitlement(httpFetch, await getSettings(ledger(), runCtx.companyId, CURRENCY), runCtx.companyId);
          if (!e.ok) {
            context.logger.info('ledger: tool refused, not entitled', { tool: decl.name, companyId: runCtx.companyId, reason: e.reason });
            return { error: notEntitledMessage(decl.name, e) };
          }
        }
        const started = Date.now();
        const result = await runTool({ db: ledger(), fetch: httpFetch, companyName: nameOf, baseCurrency: CURRENCY }, decl.name, params, runCtx);
        context.logger.info('ledger: tool', { tool: decl.name, agentId: runCtx.agentId, companyId: runCtx.companyId, ms: Date.now() - started, ...(result.error ? { error: result.error } : {}) });
        return result;
      });
    }

    // Each morning: one task per company with what needs attention, updated
    // in place while it stays open. A quiet day writes nothing.
    const BRIEFING_ORIGIN = 'plugin:ai3.ledger' as const;
    context.jobs.register('briefing', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let written = 0;
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'briefing'))) continue;
        try {
          await seedAccounts(ledger(), company.id, CURRENCY);
          const b = await buildBriefing(ledger(), company.id);
          if (!b) continue;
          const existing = (await context.issues.list({ companyId: company.id, originKind: BRIEFING_ORIGIN, originId: 'finance-briefing', limit: 20 }))
            .filter((i) => i.status !== 'done' && i.status !== 'cancelled');
          if (existing[0]) {
            await context.issues.update(existing[0].id, { title: b.title, description: b.body, priority: b.priority }, company.id);
          } else {
            await context.issues.create({ companyId: company.id, title: b.title, description: b.body, status: 'todo', priority: b.priority, originKind: BRIEFING_ORIGIN, originId: 'finance-briefing', originRunId: job.runId });
          }
          written += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          failures.push(`${company.name}: ${message}`);
          context.logger.error('ledger: briefing failed', { companyId: company.id, error: message });
        }
      }
      context.logger.info('ledger: briefing done', { runId: job.runId, written, failed: failures.length });
      // A failed company marks the run failed, so the job dashboard shows it.
      if (failures.length > 0) throw new Error(`briefing not written for ${failures.length} company(ies): ${failures.join('; ')}`.slice(0, 1000));
    });
    // Overdue reminders, daily, only for companies that turned them on.
    context.jobs.register('reminders', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let sent = 0;
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'reminders'))) continue;
        try {
          const settings = await getSettings(ledger(), company.id, CURRENCY);
          if (!settings.remindersEnabled || !isConnected(settings)) continue;
          for (const r of await dueReminders(ledger(), company.id)) {
            const inv = r.invoice;
            if (!inv.hosted?.sentTo) continue;
            const mail = reminderEmail(r, settings.legalName || company.name);
            try {
              await sendInvoice(httpFetch, settings, { companyId: company.id, token: inv.hosted.token, to: inv.hosted.sentTo, subject: mail.subject, message: mail.message, replyTo: settings.replyTo ?? settings.email ?? null });
              await markInvoiceReminded(ledger(), company.id, inv.id, r.stage);
              sent += 1;
            } catch (err) {
              failures.push(`${inv.number}: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        } catch (err) {
          failures.push(`${company.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      context.logger.info('ledger: reminders done', { runId: job.runId, sent, failed: failures.length });
      if (failures.length > 0) throw new Error(`reminders not sent: ${failures.join('; ')}`.slice(0, 1000));
    });
    // Wallet and disputes for the page.
    context.data.register('wallet', async (params) => {
      const companyId = await companyOf(params);
      const w = await getWallet(ledger(), companyId);
      if (!w) return { wallet: null };
      const balance = await balanceCents(w.address).catch(() => null);
      return { wallet: { address: w.address, network: w.network, networkLabel: TEMPO_NETWORK_LABEL, asset: PATH_USD_SYMBOL, balanceMinor: balance === null ? null : balance.toString(), explorer: explorerAddress(w.address), bankAccountId: w.bankAccountId, createdAt: w.createdAt } };
    });
    context.data.register('disputes', async (params) => ({ disputes: await listDisputes(ledger(), await companyOf(params)) }));
    // Stripe through ai3.co: what the books know (no network) plus, when connected, what ai3.co says now.
    context.data.register('stripe', async (params) => {
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      const link = await getStripeLink(ledger(), companyId);
      let remote = null;
      if (isConnected(settings)) {
        try { remote = await stripeStatus(httpFetch, settings, companyId); } catch (err) { remote = { warning: err instanceof Error ? err.message : String(err) }; }
      }
      return { ai3Connected: isConnected(settings), link, remote };
    });
    context.actions.register('stripe.connect', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      const r = await connectStripe(ledger(), httpFetch, settings, companyId, { email: s(params['email']) ?? null, country: s(params['country']) ?? null, companyName: await companyNameOf(companyId) }, CURRENCY);
      return { ...r.remote, bankAccountId: r.link.bankAccountId, paymentMethodId: r.link.paymentMethodId };
    });
    context.actions.register('stripe.status', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      const r = await refreshStripe(ledger(), httpFetch, settings, companyId, CURRENCY);
      return { ...r.remote, bankAccountId: r.link?.bankAccountId ?? null };
    });
    context.actions.register('stripe.sync', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      return (await syncStripeFeed(ledger(), httpFetch, settings, companyId, { by: 'board', autoPost: params['autoPost'] !== false })) ?? { imported: 0, notConnected: true };
    });
    // Bank feeds through ai3.co: which banks are connected, and the bank
    // account each one feeds. No network unless the company key is set.
    context.data.register('bank-feeds', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, ...(await bankFeedView(ledger(), httpFetch, await getSettings(ledger(), companyId, CURRENCY), companyId)) };
    });
    context.actions.register('bank.sync', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      // A person asking overrides the provider spacing; the daily cap is still the bank's.
      return (await syncBankFeeds(ledger(), httpFetch, settings, companyId, { by: 'board', autoPost: params['autoPost'] !== false, force: true, baseCurrency: CURRENCY })) ?? { imported: 0, notConnected: true };
    });
    context.actions.register('wallet.create', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      const r = await ensureWallet(ledger(), companyId, CURRENCY);
      return { address: r.wallet.address, created: r.created, faucet: r.faucet ?? null };
    });
    context.actions.register('wallet.faucet', async (params, ctx) => {
      boardOnly(ctx);
      const w = await getWallet(ledger(), await companyOf(params));
      if (!w) throw new Error('No wallet yet');
      return requestFaucet(w.address);
    });
    context.actions.register('wallet.sync', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      return (await syncWalletFeed(ledger(), companyId, { by: 'board', autoPost: params['autoPost'] !== false })) ?? { imported: 0 };
    });
    // Model credits: the prepaid balance held with ai3.co, and its booking into 1300 / 5000.
    context.data.register('credits', async (params) => {
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      if (!isConnected(settings)) return { connected: false, view: null, bookedMinor: null };
      let view = null;
      let error: string | null = null;
      try { view = await fetchCredits(httpFetch, settings, companyId); } catch (err) { error = err instanceof Error ? err.message : String(err); }
      const bal = await accountBalances(ledger(), companyId);
      const prepaidCode = await resolveCode(ledger(), companyId, ACCOUNT.PREPAID_CREDITS);
      const prepaid = bal.find((a) => a.code === prepaidCode);
      return { connected: true, view, error, bookedMinor: prepaid ? fromMinor(prepaid.balanceMinor) : '0' };
    });
    context.actions.register('credits.sync', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      return syncCredits(ledger(), httpFetch, await getSettings(ledger(), companyId, CURRENCY), companyId, 'board');
    });
    context.jobs.register('credits', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let synced = 0;
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'credits'))) continue;
        try {
          const r = await syncCredits(ledger(), httpFetch, await getSettings(ledger(), company.id, CURRENCY), company.id, 'credits');
          if (r.fetched && !r.skipped) synced += 1;
        } catch (err) {
          failures.push(`${company.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      context.logger.info('ledger: credits synced', { runId: job.runId, synced, failed: failures.length });
      if (failures.length > 0) throw new Error(`credits: ${failures.join('; ')}`.slice(0, 1000));
    });
    // Connected wallets: addresses watched on a chain, exchange accounts read by key.
    context.data.register('chains', async (params) => {
      await companyOf(params);
      return { chains: Object.values(CHAINS).map(chainSummary), exchanges: exchangeSummaries() };
    });
    context.data.register('connected-wallets', async (params) => {
      const companyId = await companyOf(params);
      return { companyId, wallets: await connectedWalletsView(ledger(), companyId) };
    });
    /**
      * Wallets that paid ai3.co for credits and are not watched yet. The
      * top-up is the on-ramp: the money the company just spent is the first
      * line it sees reconcile itself, and the transfer proves the address
      * without anyone signing anything. Offered, not assumed — watching an
      * address brings everything it does into the books.
      */
    context.data.register('wallet-offers', async (params) => {
      const companyId = await companyOf(params);
      const settings = await getSettings(ledger(), companyId, CURRENCY);
      if (!isConnected(settings)) return { companyId, offers: [], connected: false };
      let offers: WalletOffer[] = [];
      let error: string | null = null;
      try {
        const view = await fetchCredits(httpFetch, settings, companyId);
        const watched = (await listConnectedWallets(ledger(), companyId)).filter((w) => w.address !== null).map((w) => w.address as string);
        const own = await getWallet(ledger(), companyId);
        offers = walletOffers(view, [...watched, ...(own?.address ? [own.address] : [])]);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      // The chain a ref prefix belongs to, so the page can name it and connect it.
      const chainFor = (ref: string | null) => Object.values(CHAINS).find((c) => c.refPrefix === ref) ?? null;
      return {
        companyId, connected: true, error,
        offers: offers.map((o) => {
          const chain = chainFor(o.chainRef);
          return { ...o, network: chain?.slug ?? null, chainName: chain?.name ?? null, explorer: chain ? `${chain.explorer}/address/${o.address}` : null };
        }),
      };
    });
    context.data.register('ownership-message', async (params) => {
      const companyId = await companyOf(params);
      const address = String(params['address'] ?? '');
      const at = new Date().toISOString();
      return { message: ownershipMessage(await companyNameOf(companyId), address, at), at };
    });
    context.actions.register('wallet.connect', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      const proof = params['proof'] && typeof params['proof'] === 'object' ? (params['proof'] as { message?: unknown; signature?: unknown }) : null;
      // A top-up stands in for the signature, but only one ai3.co actually
      // reported: the page sends the address, and the offer is looked up here
      // rather than trusted from the request.
      const address = String(params['address'] ?? '');
      let topUp: { txHash: string; amountMinor: string; memo?: string | null } | null = null;
      if (params['viaTopUp'] === true) {
        const settings = await getSettings(ledger(), companyId, CURRENCY);
        const view = await fetchCredits(httpFetch, settings, companyId);
        const offer = walletOffers(view).find((o) => o.address === address.toLowerCase());
        if (!offer?.txHash) throw new Error('ai3.co has no credit top-up from that address, so it cannot stand in for a signature');
        topUp = { txHash: offer.txHash, amountMinor: offer.amountMinor, memo: view.memo };
      }
      const r = await connectAddressWallet(ledger(), companyId, {
        label: s(params['label']) ?? null, network: String(params['network'] ?? ''), address,
        proof: proof && typeof proof.message === 'string' && typeof proof.signature === 'string' ? { message: proof.message, signature: proof.signature } : null,
        topUp,
        sinceDays: Number(params['sinceDays'] ?? 0) || 0,
      }, by);
      return { ...r.wallet, chain: chainSummary(r.chain), proven: r.proven };
    });
    context.actions.register('wallet.exchange', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      const r = await connectExchangeAccount(ledger(), httpFetch, companyId, {
        label: s(params['label']) ?? null, exchange: String(params['exchange'] ?? ''), apiKey: String(params['apiKey'] ?? ''), secret: String(params['secret'] ?? ''),
        passphrase: s(params['passphrase']) ?? null, currency: String(params['currency'] ?? 'USD'), sinceDays: Number(params['sinceDays'] ?? 30) || 30,
      }, by);
      return { ...r.wallet, detail: r.detail };
    });
    context.actions.register('wallet.disconnect', async (params, ctx) => {
      boardOnly(ctx);
      return disconnectWallet(ledger(), await companyOf(params), String(params['walletId'] ?? ''));
    });
    context.actions.register('feed.sync', async (params, ctx) => {
      boardOnly(ctx);
      const companyId = await companyOf(params);
      return syncWalletForBank(ledger(), httpFetch, companyId, String(params['walletId'] ?? ''), { by: 'board', autoPost: params['autoPost'] !== false });
    });
    // Paying an invoice by its link: from the company wallet here, or booked after the person paid from their own wallet in the browser.
    context.data.register('remote-invoice', async (params) => {
      const companyId = await companyOf(params);
      const w = await getWallet(ledger(), companyId);
      return remoteInvoiceView(httpFetch, String(params['url'] ?? ''), w?.address ?? null);
    });
    context.actions.register('invoice.pay', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      return payFromCompanyWallet(ledger(), httpFetch, companyId, {
        invoiceUrl: s(params['invoiceUrl']) ?? null, to: s(params['to']) ?? null, amountMinor: s(params['amountMinor']) ?? null, memo: s(params['memo']) ?? null,
        description: s(params['description']) ?? null, accountCode: s(params['accountCode']) ?? null, billId: s(params['billId']) ?? null,
      }, by, CURRENCY);
    });
    context.actions.register('invoice.pay-book', async (params, ctx) => {
      const by = boardOnly(ctx);
      const companyId = await companyOf(params);
      return bookBrowserPayment(ledger(), httpFetch, companyId, {
        network: String(params['network'] ?? ''), txHash: String(params['txHash'] ?? ''), from: String(params['from'] ?? ''), to: String(params['to'] ?? ''), amountMinor: String(params['amountMinor'] ?? '0'),
        description: s(params['description']) ?? null, accountCode: s(params['accountCode']) ?? null, billId: s(params['billId']) ?? null, invoiceUrl: s(params['invoiceUrl']) ?? null,
      }, by);
    });
    // Every five minutes: read the chain into each wallet's bank account and
    // post what the matcher is sure of; refresh disputes still being decided.
    context.jobs.register('chain-feed', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let imported = 0;
      let posted = 0;
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'chain-feed'))) continue;
        try {
          const r = await syncWalletFeed(ledger(), company.id, { by: 'chain-feed' });
          if (r) { imported += r.imported; posted += r.autoPosted; }
          // Connected wallets and exchange accounts on the same cadence; a failing one is noted on the wallet, not thrown.
          for (const cw of await syncAllConnected(ledger(), httpFetch, company.id, { by: 'chain-feed' })) {
            imported += cw.imported;
            posted += cw.autoPosted;
            if (cw.error) context.logger.warn('ledger: wallet feed failed', { companyId: company.id, wallet: cw.label, error: cw.error });
          }
          // Stripe balance on the same cadence, for companies that connected it.
          try {
            const st = await syncStripeFeed(ledger(), httpFetch, await getSettings(ledger(), company.id, CURRENCY), company.id, { by: 'stripe-feed' });
            if (st) { imported += st.imported; posted += st.autoPosted; }
          } catch (err) {
            failures.push(`${company.name} (stripe): ${err instanceof Error ? err.message : String(err)}`);
          }
          for (const d of await listDisputes(ledger(), company.id)) {
            if (!d.caseId || d.ruling || !(d.status === 'pending' || d.status === 'filed')) continue;
            const rec = await getCase(httpFetch, d.caseId).catch(() => null);
            if (!rec) continue;
            const ruling = (rec.ruling ?? null) as Ruling | null;
            if (ruling || (rec.status && rec.status !== d.status)) await updateDispute(ledger(), company.id, d.id, { status: ruling ? 'decided' : rec.status, ruling, instruction: rec.rail_instruction ?? d.instruction });
          }
        } catch (err) {
          failures.push(`${company.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      context.logger.info('ledger: chain feed done', { runId: job.runId, imported, posted, failed: failures.length });
      if (failures.length > 0) throw new Error(`chain feed: ${failures.join('; ')}`.slice(0, 1000));
    });
    // Banks, on the aggregators' terms: the job runs often enough that a
    // freshly linked account is pulled within the half hour, and syncBankFeeds
    // itself declines to ask a provider before its own floor (six hours for
    // GoCardless, whose daily cap is small).
    context.jobs.register('bank-feed', async (job) => {
      const companies = await context.companies.list({ limit: 500 });
      let imported = 0;
      let posted = 0;
      let waited = 0;
      const reconnect: string[] = [];
      const failures: string[] = [];
      for (const company of companies) {
        if (!(await jobAllowed(company.id, httpFetch, 'bank-feed'))) continue;
        try {
          const r = await syncBankFeeds(ledger(), httpFetch, await getSettings(ledger(), company.id, CURRENCY), company.id, { by: 'bank-feed', baseCurrency: CURRENCY });
          if (!r) continue;
          imported += r.imported;
          posted += r.autoPosted;
          waited += r.waited;
          for (const name of r.needsReconnect) reconnect.push(`${company.name}: ${name}`);
          for (const a of r.perAccount) {
            if (a.error && !a.reconnect) context.logger.warn('ledger: bank feed failed', { companyId: company.id, account: a.name, error: a.error });
            if (a.otherCurrency > 0) context.logger.info('ledger: bank lines in another currency skipped', { companyId: company.id, account: a.name, currency: a.currency, skipped: a.otherCurrency });
          }
        } catch (err) {
          failures.push(`${company.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      context.logger.info('ledger: bank feed done', { runId: job.runId, imported, posted, waited, reconnect: reconnect.length, failed: failures.length });
      // A revoked authorisation is the owner's to renew, so it is said out loud but does not fail the job.
      if (reconnect.length > 0) context.logger.warn('ledger: bank connections need reconnecting', { accounts: reconnect.slice(0, 20) });
      if (failures.length > 0) throw new Error(`bank feed: ${failures.join('; ')}`.slice(0, 1000));
    });
    // A fresh tenant should not wait for the next quarter hour: first sweep
    // (which also installs the company skill) shortly after boot.
    setTimeout(() => { void sweepAll().catch((err) => context.logger.warn('ledger: first sweep failed', { error: err instanceof Error ? err.message : String(err) })); }, 20_000);
    // Journals, trial balance, drill-down, bills, documents, imports.
    registerBooks(context, { ledger, companyOf, boardOnly, httpFetch, currency: CURRENCY });
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
