-- Generated from plugin-sql/0016_streams.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

ALTER TABLE plugin_ai3_ledger_2571fd243c.meter_events ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'balance';
ALTER TABLE plugin_ai3_ledger_2571fd243c.meter_events DROP CONSTRAINT IF EXISTS meter_events_funding_check;
ALTER TABLE plugin_ai3_ledger_2571fd243c.meter_events ADD CONSTRAINT meter_events_funding_check CHECK (funding IN ('balance', 'accrual', 'prepaid'));
ALTER TABLE plugin_ai3_ledger_2571fd243c.meter_events ADD COLUMN IF NOT EXISTS stream_id uuid NULL;

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.meter_streams (
  id             uuid PRIMARY KEY,
  company_id     text NOT NULL,
  payer          text NOT NULL,
  recipient      text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('time', 'usage', 'output', 'outcome')),
  meter          text NOT NULL,
  rate_minor     bigint NOT NULL DEFAULT 0 CHECK (rate_minor >= 0),
  rate_pct       numeric(9, 4) NULL,
  currency       text NOT NULL,
  cap_minor      bigint NULL,
  cap_period     text NOT NULL DEFAULT 'total' CHECK (cap_period IN ('total', 'day', 'month')),
  accrued_minor  bigint NOT NULL DEFAULT 0 CHECK (accrued_minor >= 0),
  settled_minor  bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'ended')),
  internal       boolean NOT NULL DEFAULT false,
  account_code   text NOT NULL,
  notice_seconds integer NOT NULL DEFAULT 0 CHECK (notice_seconds >= 0),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz NULL,
  last_tick_at   timestamptz NULL,
  cancelled_at   timestamptz NULL,
  cancel_reason  text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS meter_streams_company ON plugin_ai3_ledger_2571fd243c.meter_streams (company_id, status);
CREATE INDEX IF NOT EXISTS meter_streams_recipient ON plugin_ai3_ledger_2571fd243c.meter_streams (company_id, recipient);
CREATE INDEX IF NOT EXISTS meter_events_stream ON plugin_ai3_ledger_2571fd243c.meter_events (company_id, stream_id);
