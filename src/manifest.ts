import type { PaperclipPluginManifestV1 } from '@paperclipai/plugin-sdk';
import { TOOL_DECLARATIONS } from './plugin/tools.js';

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
  version: '0.9.0',
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
    'http.outbound',
    'agent.tools.register',
    'issues.read',
    'issues.create',
    'issues.update',
  ],
  entrypoints: {
    worker: 'dist/plugin/worker.js',
    ui: 'dist/ui',
  },
  ui: {
    slots: [
      { type: 'page', id: 'ledger-page', displayName: 'Ledger', exportName: 'LedgerPage', routePath: 'ledger', order: 10 },
      { type: 'sidebar', id: 'finance-nav', displayName: 'Finance', exportName: 'LedgerSidebarItem', order: 10 },
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
    { routeKey: 'invoices.writeoff', method: 'POST', path: '/invoices/:id/write-off', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'invoices.void', method: 'POST', path: '/invoices/:id/void', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    // M4: periods and reports
    { routeKey: 'periods.list', method: 'GET', path: '/periods', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'periods.create', method: 'POST', path: '/periods', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'periods.close', method: 'POST', path: '/periods/:id/close', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'body', key: 'companyId' } },
    { routeKey: 'reports.pnl', method: 'GET', path: '/reports/pnl', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
    { routeKey: 'reports.balance-sheet', method: 'GET', path: '/reports/balance-sheet', auth: 'board', capability: 'api.routes.register', companyResolution: { from: 'query', key: 'companyId' } },
  ],
  // M6: what an agent in the company can do with the books. Exposed by the
  // host through its tool gateway as ai3.ledger:<name>.
  tools: TOOL_DECLARATIONS,
};

export default manifest;
