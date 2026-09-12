-- Generated from plugin-sql/0010_connected_wallets.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.connected_wallets (
  id              uuid PRIMARY KEY,
  company_id      text NOT NULL,
  kind            text NOT NULL CHECK (kind IN ('address','exchange')),
  label           text NOT NULL,
  network         text NULL,
  address         text NULL,
  exchange        text NULL,
  currency        text NOT NULL,
  credentials     text NULL,
  proof           jsonb NULL,
  bank_account_id uuid NULL REFERENCES plugin_ai3_ledger_2571fd243c.bank_accounts(id),
  cursor_json     jsonb NULL,
  last_sync_at    timestamptz NULL,
  last_error      text NULL,
  created_by      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz NULL
);
CREATE INDEX IF NOT EXISTS connected_wallets_company_idx ON plugin_ai3_ledger_2571fd243c.connected_wallets (company_id, created_at);

CREATE TABLE IF NOT EXISTS plugin_ai3_ledger_2571fd243c.ledger_vault (
  id          integer PRIMARY KEY CHECK (id = 1),
  key_b64     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE plugin_ai3_ledger_2571fd243c.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_feed_check;
ALTER TABLE plugin_ai3_ledger_2571fd243c.bank_accounts ADD CONSTRAINT bank_accounts_feed_check CHECK (feed IN ('upload','stripe','aggregator','tempo','chain','exchange'));
