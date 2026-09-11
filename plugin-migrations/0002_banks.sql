-- Generated from plugin-sql/0002_banks.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.bank_accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    text NOT NULL,
  name          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('bank','card','stripe','wallet')),
  currency      text NOT NULL,
  feed          text NOT NULL DEFAULT 'upload' CHECK (feed IN ('upload','stripe','aggregator')),
  account_id    uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.accounts(id),
  external_ref  text NULL,
  connected_at  timestamptz NULL,
  archived_at   timestamptz NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bank_accounts_company ON plugin_ai3_ledger_2571fd243c.bank_accounts (company_id);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.statement_lines (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                text NOT NULL,
  bank_account_id           uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.bank_accounts(id),
  posted_at                 timestamptz NOT NULL,
  amount_minor              bigint NOT NULL,
  description               text NOT NULL DEFAULT '',
  payee                     text NULL,
  reference                 text NULL,
  external_id               text NULL,
  balance_after_minor       bigint NULL,
  dedupe_key                text NOT NULL,
  status                    text NOT NULL DEFAULT 'unreconciled' CHECK (status IN ('unreconciled','matched','created','transferred','excluded')),
  reconciled_transaction_id uuid NULL REFERENCES plugin_ai3_ledger_2571fd243c.transactions(id),
  reconciled_at             timestamptz NULL,
  reconciled_by             text NULL,
  proposal                  jsonb NULL,
  proposed_at               timestamptz NULL,
  import_batch              text NULL,
  created_at                timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bank_account_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS statement_lines_account_status ON plugin_ai3_ledger_2571fd243c.statement_lines (bank_account_id, status);
CREATE INDEX IF NOT EXISTS statement_lines_company_posted ON plugin_ai3_ledger_2571fd243c.statement_lines (company_id, posted_at);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.reconciliation_links (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     text NOT NULL,
  line_id        uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.statement_lines(id),
  transaction_id uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.transactions(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (transaction_id),
  UNIQUE (line_id, transaction_id)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.bank_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     text NOT NULL,
  payee_contains text NOT NULL,
  direction      text NOT NULL DEFAULT 'any' CHECK (direction IN ('in','out','any')),
  account_code   text NOT NULL,
  contact_name   text NULL,
  confirmations  integer NOT NULL DEFAULT 1,
  misses         integer NOT NULL DEFAULT 0,
  enabled        boolean NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, payee_contains, direction)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.reconciliation_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       text NOT NULL,
  bank_account_id  uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.bank_accounts(id),
  ran_at           timestamptz NOT NULL DEFAULT now(),
  ran_by           text NOT NULL,
  lines_seen       integer NOT NULL DEFAULT 0,
  auto_posted      integer NOT NULL DEFAULT 0,
  left_for_review  integer NOT NULL DEFAULT 0,
  threshold        integer NOT NULL DEFAULT 90
);

CREATE INDEX IF NOT EXISTS reconciliation_runs_account ON plugin_ai3_ledger_2571fd243c.reconciliation_runs (bank_account_id, ran_at);
