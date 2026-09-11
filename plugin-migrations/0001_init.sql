-- Generated from plugin-sql/0001_init.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id    text NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('asset','liability','income','expense','equity')),
  parent_id     uuid NULL REFERENCES plugin_ai3_ledger_2571fd243c.accounts(id),
  currency      text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (public_id)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.periods (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id    text NOT NULL,
  starts_on     date NOT NULL,
  ends_on       date NOT NULL,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
  closed_at     timestamptz NULL,
  closed_by     text NULL,
  CHECK (ends_on >= starts_on),
  UNIQUE (company_id, starts_on)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id      text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  description     text NOT NULL DEFAULT '',
  source_platform text NOT NULL,
  source_kind     text NOT NULL CHECK (source_kind IN ('cost_sweep','funding','invoice','payment','manual','reversal')),
  source_ref      text NULL,
  period_id       uuid NULL REFERENCES plugin_ai3_ledger_2571fd243c.periods(id),
  reverses_id     uuid NULL REFERENCES plugin_ai3_ledger_2571fd243c.transactions(id),
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted')),
  UNIQUE (public_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS transactions_source_uniq
  ON plugin_ai3_ledger_2571fd243c.transactions (company_id, source_platform, source_kind, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_company_occurred
  ON plugin_ai3_ledger_2571fd243c.transactions (company_id, occurred_at);

CREATE INDEX IF NOT EXISTS transactions_pending
  ON plugin_ai3_ledger_2571fd243c.transactions (created_at)
  WHERE status = 'pending';

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.transactions(id),
  account_id          uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.accounts(id),
  subject_agent_ref   text NULL,
  subject_project_ref text NULL,
  subject_goal_ref    text NULL,
  subject_work_ref    text NULL,
  direction           text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_transaction ON plugin_ai3_ledger_2571fd243c.entries (transaction_id);
CREATE INDEX IF NOT EXISTS entries_account ON plugin_ai3_ledger_2571fd243c.entries (account_id);
CREATE INDEX IF NOT EXISTS entries_agent ON plugin_ai3_ledger_2571fd243c.entries (subject_agent_ref) WHERE subject_agent_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.treasury_allocations (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id                text NOT NULL,
  subject_agent_ref         text NOT NULL,
  allocated_minor           bigint NOT NULL CHECK (allocated_minor >= 0),
  currency                  text NOT NULL,
  per_transaction_cap_minor bigint NULL CHECK (per_transaction_cap_minor IS NULL OR per_transaction_cap_minor >= 0),
  per_period_cap_minor      bigint NULL CHECK (per_period_cap_minor IS NULL OR per_period_cap_minor >= 0),
  period                    text NOT NULL DEFAULT 'month',
  created_at                timestamptz NOT NULL DEFAULT now(),
  revoked_at                timestamptz NULL
);

CREATE INDEX IF NOT EXISTS treasury_allocations_company_agent
  ON plugin_ai3_ledger_2571fd243c.treasury_allocations (company_id, subject_agent_ref) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id   text NOT NULL,
  name         text NOT NULL,
  email        text NULL,
  external_ref text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_id)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  share_token        text NULL,
  company_id         text NOT NULL,
  customer_id        uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.customers(id),
  number             text NOT NULL,
  issued_at          timestamptz NULL,
  due_at             timestamptz NULL,
  currency           text NOT NULL,
  subtotal_minor     bigint NOT NULL DEFAULT 0,
  total_minor        bigint NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'draft'
                     CHECK (status IN ('draft','issued','part_paid','paid','written_off','void')),
  subject_work_ref   text NULL,
  subject_goal_ref   text NULL,
  subject_agent_ref  text NULL,
  created_by         text NOT NULL DEFAULT 'system',
  created_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_id),
  UNIQUE (company_id, number)
);

CREATE UNIQUE INDEX IF NOT EXISTS invoices_share_token ON plugin_ai3_ledger_2571fd243c.invoices (share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES plugin_ai3_ledger_2571fd243c.invoices(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  description       text NOT NULL,
  quantity          numeric(18,4) NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  amount_minor      bigint NOT NULL,
  UNIQUE (invoice_id, position)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.sweep_cursor (
  company_id       text NOT NULL,
  source_platform  text NOT NULL,
  last_event_ref   text NULL,
  last_occurred_at timestamptz NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, source_platform)
);
