CREATE TABLE IF NOT EXISTS company_stripe (
  company_id           text PRIMARY KEY,
  account_id           text NULL,
  bank_account_id      uuid NULL,
  payment_method_id    uuid NULL,
  card_bank_account_id uuid NULL,
  charges_enabled      boolean NOT NULL DEFAULT false,
  payouts_enabled      boolean NOT NULL DEFAULT false,
  details_submitted    boolean NOT NULL DEFAULT false,
  feed_cursor_unix     bigint NOT NULL DEFAULT 0,
  last_synced_at       timestamptz NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
