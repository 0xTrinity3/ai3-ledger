CREATE TABLE IF NOT EXISTS __NS__.company_wallets (
  company_id     text PRIMARY KEY,
  network        text NOT NULL,
  address        text NOT NULL,
  private_key    text NOT NULL,
  bank_account_id uuid NULL,
  payment_method_id uuid NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __NS__.chain_cursors (
  bank_account_id uuid PRIMARY KEY,
  last_block      bigint NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __NS__.disputes (
  id             uuid PRIMARY KEY,
  company_id     text NOT NULL,
  invoice_id     uuid NULL,
  invoice_number text NULL,
  invoice_url    text NULL,
  role           text NOT NULL CHECK (role IN ('claimant','respondent')),
  case_id        text NULL,
  venue          text NOT NULL DEFAULT 'recourse',
  status         text NOT NULL DEFAULT 'filed',
  amount_minor   bigint NOT NULL DEFAULT 0,
  currency       text NOT NULL,
  claim          text NOT NULL,
  ruling         jsonb NULL,
  instruction    jsonb NULL,
  settled_tx     text NULL,
  filed_by       text NULL,
  filed_at       timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS disputes_company_idx ON __NS__.disputes (company_id, filed_at DESC);

ALTER TABLE __NS__.bank_accounts DROP CONSTRAINT IF EXISTS bank_accounts_feed_check;
ALTER TABLE __NS__.bank_accounts ADD CONSTRAINT bank_accounts_feed_check CHECK (feed IN ('upload','stripe','aggregator','tempo'));
