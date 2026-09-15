import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';
import { TOOL_DECLARATIONS } from './plugin/tools.js';
import { LEDGER_SKILL } from './plugin/skill.js';

/**
 * Paperclip plugin manifest. Loaded by the host as a JS module (dist/manifest.js).
 *
 * The database namespace is derived by the host from `id` and `namespaceSlug`:
 *   plugin_<namespaceSlug>_<sha256(id).slice(0, 10)>  →  plugin_ai3_ledger_2571fd243c
 * Migration SQL must name that schema literally; scripts/gen-plugin-migration.mjs
 * writes it from plugin-sql/*.sql so the two can never drift.
 */
const manifest: PaperclipPluginManifestV1 = {
  id: 'ai3.ledger',
  apiVersion: 1,
  version: '0.26.1',
  displayName: 'AI3 Ledger',
  description: 'Double-entry accounting for an agent company: treasury, burn, P&L and balance sheet from Paperclip cost events.',
  author: 'AI3 (ai3.co)',
  categories: ['automation'],
  capabilities: [
    'companies.read',
    'costs.read',
    'database.namespace.read',
    'database.namespace.write',
    'database.namespace.migrate',
    'jobs.schedule',
    'api.routes.register',
    'ui.page.register',
    'ui.sidebar.register',
    'instance.settings.register',
    'http.outbound',
    'agent.tools.register',
    'issues.read',
    'issues.create',
    'issues.update',
    'skills.managed',
  ],
  entrypoints: {
    worker: 'dist/plugin/worker.js',
    ui: 'dist/ui',
  },
  ui: {
    slots: [
      { type: 'page', id: 'ledger-page', displayName: 'Ledger', exportName: 'LedgerPage', routePath: 'ledger', order: 10 },
          // A sidebarPanel renders after the host's own groups, so Finance follows
    // the work and the organisation rather than sitting in the middle of Work.
    { type: 'sidebarPanel', id: 'finance-nav', displayName: 'Finance', exportName: 'LedgerSidebarItem', order: 10 },
      // Finance settings live with the company's other settings (Members, Secrets…) at /<prefix>/company/settings/finance.
      { type: 'companySettingsPage', id: 'finance-settings', displayName: 'Finance', exportName: 'LedgerCompanySettings', routePath: 'finance', order: 40 },
      // The organisation's default model, one choice for every agent; applied through ai3.co. /<prefix>/company/settings/model.
      { type: 'companySettingsPage', id: 'model-settings', displayName: 'Model', exportName: 'ModelSettings', routePath: 'model', order: 41 },
    ],
  },
  database: {
    namespaceSlug: 'ai3_ledger',
    migrationsDir: 'plugin-migrations',
    coreReadTables: ['cost_events'],
  },
  jobs: [
    {
      jobKey: 'sweep',
      displayName: 'Cost sweep',
      description: 'Posts new Paperclip cost events into the ledger for every company.',
      schedule: '*/15 * * * *',
    },
    {
      jobKey: 'reconcile',
      displayName: 'Bank reconciliation',
      description: 'Matches new statement lines to the books and posts everything above the confidence threshold; the rest wait for a person.',
      schedule: '15 3 * * *',
    },
    {
      jobKey: 'briefing',
      displayName: 'Finance briefing',
      description: 'Each morning, writes what needs attention (overdue and unsent invoices, unreconciled lines, short runway) as one task per company, updated in place.',
      schedule: '0 8 * * *',
    },
    {
      jobKey: 'reminders',
      displayName: 'Overdue reminders',
      description: 'Emails a reminder at 3, 14 and 30 days past due from the owner’s mailbox, for companies that turned reminders on.',
      schedule: '0 9 * * *',
    },
    {
      jobKey: 'publish',
      displayName: 'Publish summary',
      description: 'Once a day, sends each connected company’s figures (revenue, profit, cash, burn, receivables, model costs over the trailing 30 days) to ai3.co for the owner’s portfolio page and, only where the company opted in, the public leaderboard.',
      schedule: '30 4 * * *',
    },
    {
      jobKey: 'market',
      displayName: 'Marketplace billing',
      description: 'Invoices what ai3.co says is due for the agents this company sells, reports back what has been collected, and \u2014 for the platform company \u2014 bills developers their commission on what they collected. Runs after the summary is published so a profit-share line is measured on the month it belongs to.',
      schedule: '0 5 * * *',
    },
    {
      jobKey: 'credits',
      displayName: 'Model credits',
      description: 'Every hour, reads each hosted company’s model-credit balance from ai3.co and books grants, top-ups and usage so the books agree with the platform.',
      schedule: '20 * * * *',
    },
    {
      jobKey: 'bank-feed',
      displayName: 'Bank feed',
      description: 'Reads new transactions from every bank and card connected through ai3.co (Plaid, GoCardless) into their bank accounts and posts what the matcher is sure of. Each provider is asked no more often than it allows, so a freshly linked account appears within the half hour and a rate limit is never spent.',
      schedule: '*/30 * * * *',
    },
    {
      jobKey: 'chain-feed',
      displayName: 'Wallet feed',
      description: 'Reads the company wallet on Tempo, every connected wallet address on Tempo, Base and Ethereum, and every connected exchange account into their bank accounts; posts what the matcher is sure of; refreshes disputes still being decided.',
      schedule: '*/5 * * * *',
    },
  ],
  apiRoutes: [
    { routeKey: 'position', method: 'GET', path: '/position', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'accounts', method: 'GET', path: '/accounts', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'transactions', method: 'GET', path: '/transactions', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'funding', method: 'POST', path: '/funding', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'sweep', method: 'POST', path: '/sweep', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    // M3: customers, invoices, receivables, payments
    { routeKey: 'customers.list', method: 'GET', path: '/customers', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'customers.create', method: 'POST', path: '/customers', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.list', method: 'GET', path: '/invoices', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'invoices.get', method: 'GET', path: '/invoices/:id', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    // an agent may raise an invoice; it is always a draft and a person issues it
    { routeKey: 'invoices.create', method: 'POST', path: '/invoices', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.issue', method: 'POST', path: '/invoices/:id/issue', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.payment', method: 'POST', path: '/invoices/:id/payments', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.credit', method: 'POST', path: '/invoices/:id/credit', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.writeoff', method: 'POST', path: '/invoices/:id/write-off', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.void', method: 'POST', path: '/invoices/:id/void', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    // M4: periods and reports
    { routeKey: 'periods.list', method: 'GET', path: '/periods', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'periods.create', method: 'POST', path: '/periods', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'periods.close', method: 'POST', path: '/periods/:id/close', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'reports.pnl', method: 'GET', path: '/reports/pnl', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'reports.balance-sheet', method: 'GET', path: '/reports/balance-sheet', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'reports.trial-balance', method: 'GET', path: '/reports/trial-balance', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'entries', method: 'GET', path: '/entries', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },

    // Everything a person does to these books, over HTTP.
    //
    // Until now the plugin published the reports and the invoices and kept the
    // rest to itself, so a company with a Paperclip instance could read its
    // profit and loss on ai3.co and had to go back into Paperclip to post a
    // journal, approve a bill or reconcile a statement line. That is not a
    // decision about where anybody's books belong — it was a gap in this list.
    //
    // Every route below wraps the same core function the plugin's own screens
    // call, with the same board-only rule on anything that writes.
    { routeKey: 'journals.list', method: 'GET', path: '/journals', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'journals.get', method: 'GET', path: '/journals/:id', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'journals.create', method: 'POST', path: '/journals', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'journals.post', method: 'POST', path: '/journals/:id/post', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'journals.void', method: 'POST', path: '/journals/:id/void', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'journals.delete', method: 'POST', path: '/journals/:id/delete', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },

    { routeKey: 'suppliers.list', method: 'GET', path: '/suppliers', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'suppliers.create', method: 'POST', path: '/suppliers', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'bills.list', method: 'GET', path: '/bills', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'bills.get', method: 'GET', path: '/bills/:id', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'bills.create', method: 'POST', path: '/bills', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'bills.approve', method: 'POST', path: '/bills/:id/approve', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'bills.pay', method: 'POST', path: '/bills/:id/pay', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'bills.void', method: 'POST', path: '/bills/:id/void', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'bills.delete', method: 'POST', path: '/bills/:id/delete', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },

    { routeKey: 'banks.list', method: 'GET', path: '/banks', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'banks.create', method: 'POST', path: '/banks', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'banks.lines', method: 'GET', path: '/banks/:id/lines', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'banks.import', method: 'POST', path: '/banks/:id/import', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'reconcile.run', method: 'POST', path: '/banks/:id/reconcile', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'reconcile.decide', method: 'POST', path: '/reconcile/:id/decide', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'reconcile.rules', method: 'GET', path: '/reconcile/rules', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'reconcile.rule', method: 'POST', path: '/reconcile/rules/:id', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },

    { routeKey: 'settings.get', method: 'GET', path: '/settings', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'settings.update', method: 'POST', path: '/settings', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'payments.list', method: 'GET', path: '/payment-methods', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'payments.create', method: 'POST', path: '/payment-methods', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'payments.update', method: 'POST', path: '/payment-methods/:id', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },

    { routeKey: 'import.chart', method: 'POST', path: '/import/chart', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'import.opening', method: 'POST', path: '/import/opening-balances', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'meter.balances', method: 'GET', path: '/meter/balances', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'meter.fund', method: 'POST', path: '/meter/fund', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'meter.reserve', method: 'POST', path: '/meter/reserve', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'meter.capture', method: 'POST', path: '/meter/capture', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'meter.release', method: 'POST', path: '/meter/release', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'meter.events', method: 'GET', path: '/meter/events', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'meter.aggregate', method: 'POST', path: '/meter/aggregate', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'meter.statement', method: 'GET', path: '/meter/statement', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'meter.invoice', method: 'POST', path: '/meter/invoice', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'streams.list', method: 'GET', path: '/streams', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'streams.open', method: 'POST', path: '/streams', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'streams.accrue', method: 'POST', path: '/streams/:id/accrue', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'streams.tick', method: 'POST', path: '/streams/:id/tick', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'streams.pause', method: 'POST', path: '/streams/:id/pause', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'streams.cancel', method: 'POST', path: '/streams/:id/cancel', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'streams.withdraw', method: 'POST', path: '/streams/:id/withdraw', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'import.documents', method: 'POST', path: '/import/documents', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'import.standing', method: 'GET', path: '/import/opening-balances', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'import.undo', method: 'POST', path: '/import/opening-balances/undo', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },

    // M6: the agent tools over plain HTTP, for runs without an MCP gateway. Same
    // functions as the tool declarations; the company skill explains the call.
    { routeKey: 'tools.list', method: 'GET', path: '/tools', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'tools.invoke', method: 'POST', path: '/tools/:name', auth: 'board-or-agent', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
  ],
  // The company skill that teaches agents the routes above. Reconciled into
  // each company's skills library by the worker; Paperclip delivers every
  // company skill to every agent run.
  skills: [LEDGER_SKILL],
  // M6: what an agent in the company can do with the books. Exposed by the
  // host through its tool gateway as ai3.ledger:<name>.
  tools: TOOL_DECLARATIONS,
};

export default manifest;
