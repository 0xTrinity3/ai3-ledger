# AI3 Ledger

Double-entry books for a company run by agents, as a [Paperclip](https://paperclip.ing) plugin: treasury, burn and runway from Paperclip's own cost events; invoices in any currency with hosted pages and email; bank accounts, statement imports and AI-proposed reconciliation; profit and loss and balance sheet.

**Agents can run the books.** Every agent in the company gets fifteen tools (position, invoices, create-invoice, send-invoice, record-payment, reconcile, profit-and-loss, …) both as `ai3.ledger:<name>` on Paperclip's tool gateway and as plain HTTP routes at `/api/plugins/ai3.ledger/api/tools/<name>`, plus a company skill that explains them. A daily briefing task lists overdue and unsent invoices, unreconciled lines and short runway, each pointing at the tool that fixes it.

## Install

```bash
paperclipai plugin install @ai3/ledger
```

Then open **Finance** in the sidebar. Hosted invoice pages, emailing from the owner's Gmail and overdue reminders need a company key from [ai3.co](https://ai3.co): companies created through ai3.co are connected already; a self-hosted instance pastes the key under Finance › Settings.

Spec: [`../PRD-ai3-ledger.md`](../PRD-ai3-ledger.md).

## Layout

```
migrations/   SQL schema, triggers, and the atomic ledger_post() function
src/core/     the ledger: accounts, posting, balances, the adapter boundary. No platform imports.
src/adapters/ platform adapters (Paperclip first). Each turns platform costs into CostRecords.
src/plugin/   the Paperclip plugin worker: manifest, jobs, routes, tools.
test/         real PostgreSQL (pglite) with the real migration. No database mocks.
```

## Invariants, enforced in the database as well as in code

- Every transaction sums to zero (deferred constraint trigger).
- The ledger is append-only; updates and deletes are refused. Corrections are reversing transactions.
- Money is `bigint` minor units. Never floats.
- Posting is atomic through one `SELECT ... FROM ledger_post(...)` call, because the plugin database API has no transaction control.
- A repeated (company, platform, kind, source ref) is a no-op that returns the original id. This is what makes the cost sweep replay-safe.
- A closed period refuses new transactions dated inside it.

## Run

```bash
nvm use            # Node 24, same as the box
npm install
npm test
npm run typecheck
```

## Status

M1 — schema, double-entry core, adapter boundary, tests. See the PRD for M2 onward.
