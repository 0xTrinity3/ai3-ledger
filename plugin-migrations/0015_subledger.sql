-- Generated from plugin-sql/0015_subledger.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.meter_balances (
  company_id      text NOT NULL,
  holder          text NOT NULL,
  currency        text NOT NULL,
  available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  reserved_minor  bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, holder, currency)
);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.meter_events (
  id                uuid PRIMARY KEY,
  company_id        text NOT NULL,
  holder            text NOT NULL,
  status            text NOT NULL CHECK (status IN ('reserved', 'captured', 'released', 'void')),
  kind              text NOT NULL CHECK (kind IN ('usage', 'time', 'output', 'outcome')),
  counterparty      text NULL,
  internal          boolean NOT NULL DEFAULT false,
  sku               text NULL,
  quantity          numeric(20, 6) NULL,
  unit_amount_minor bigint NULL,
  amount_minor      bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  reserved_minor    bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  pass_through_minor bigint NOT NULL DEFAULT 0 CHECK (pass_through_minor >= 0),
  currency          text NOT NULL,
  account_code      text NOT NULL,
  agent_ref         text NULL,
  project_ref       text NULL,
  goal_ref          text NULL,
  work_ref          text NULL,
  customer          text NULL,
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  captured_at       timestamptz NULL,
  released_at       timestamptz NULL,
  reference         text NULL,
  batch_id          uuid NULL,
  created_by        text NOT NULL DEFAULT 'system'
);

CREATE UNIQUE INDEX IF NOT EXISTS meter_events_reference ON plugin_ai3_ledger_2571fd243c.meter_events (company_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS meter_events_unposted ON plugin_ai3_ledger_2571fd243c.meter_events (company_id, status, batch_id);
CREATE INDEX IF NOT EXISTS meter_events_holder ON plugin_ai3_ledger_2571fd243c.meter_events (company_id, holder, occurred_at);
CREATE INDEX IF NOT EXISTS meter_events_when ON plugin_ai3_ledger_2571fd243c.meter_events (company_id, occurred_at);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.meter_batches (
  id             uuid PRIMARY KEY,
  company_id     text NOT NULL,
  from_at        timestamptz NOT NULL,
  to_at          timestamptz NOT NULL,
  transaction_id uuid NULL,
  event_count    integer NOT NULL DEFAULT 0,
  amount_minor   bigint NOT NULL DEFAULT 0,
  currency       text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS meter_batches_company ON plugin_ai3_ledger_2571fd243c.meter_batches (company_id, to_at);
