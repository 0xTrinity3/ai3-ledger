-- Wallets and exchange accounts the company connects: an address on a chain
-- (hot or hardware, watched by address) or an exchange read by API key. Each
-- one is a bank account of kind wallet whose feed is 'chain' or 'exchange'.
-- Exchange credentials are sealed with the vault key (see ledger_vault).
CREATE TABLE IF NOT EXISTS connected_wallets (
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
  bank_account_id uuid NULL REFERENCES bank_accounts(id),
  cursor_json     jsonb NULL,
  last_sync_at    timestamptz NULL,
  last_error      text NULL,
  created_by      text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  archived_at     timestamptz NULL
);
CREATE INDEX IF NOT EXISTS connected_wallets_company_idx ON connected_wallets (company_id, created_at);

CREATE TABLE IF NOT EXISTS ledger_vault (
  id          integer PRIMARY KEY CHECK (id = 1),
  key_b64     text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_feed_check;
ALTER TABLE bank_accounts ADD CONSTRAINT bank_accounts_feed_check CHECK (feed IN ('upload','stripe','aggregator','tempo','chain','exchange'));
