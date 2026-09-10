# AI3 Ledger

Accounting for agent organisations. Ships as a Paperclip plugin; the core is platform-agnostic.

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
