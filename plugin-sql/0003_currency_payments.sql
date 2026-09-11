CREATE TABLE IF NOT EXISTS __NS__.company_settings (
  company_id      text PRIMARY KEY,
  base_currency   text NOT NULL DEFAULT 'USD',
  legal_name      text NULL,
  address         text NULL,
  email           text NULL,
  tax_id          text NULL,
  invoice_footer  text NULL,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS __NS__.payment_methods (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  text NOT NULL,
  kind        text NOT NULL CHECK (kind IN ('bank','stripe','crypto','other')),
  label       text NOT NULL,
  currency    text NULL,
  details     jsonb NOT NULL DEFAULT '{}'::jsonb,
  is_default  boolean NOT NULL DEFAULT true,
  enabled     boolean NOT NULL DEFAULT true,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payment_methods_company ON __NS__.payment_methods (company_id, enabled);

ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS rate_to_base numeric(20,10) NOT NULL DEFAULT 1;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS base_currency text NULL;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS base_total_minor bigint NULL;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS payment_methods jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS notes text NULL;

CREATE TABLE IF NOT EXISTS __NS__.invoice_payments (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id      text NOT NULL,
  invoice_id      uuid NOT NULL REFERENCES __NS__.invoices(id),
  transaction_id  uuid NULL REFERENCES __NS__.transactions(id),
  occurred_at     timestamptz NOT NULL,
  amount_minor    bigint NOT NULL,
  rate_to_base    numeric(20,10) NOT NULL DEFAULT 1,
  base_minor      bigint NOT NULL,
  reference       text NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (invoice_id, reference)
);

CREATE INDEX IF NOT EXISTS invoice_payments_invoice ON __NS__.invoice_payments (invoice_id);

INSERT INTO __NS__.invoice_payments (company_id, invoice_id, transaction_id, occurred_at, amount_minor, rate_to_base, base_minor, reference)
SELECT t.company_id, split_part(t.source_ref, ':', 2)::uuid, t.id, t.occurred_at, e.amount_minor, 1, e.amount_minor, substr(t.source_ref, 46)
  FROM __NS__.transactions t
  JOIN __NS__.entries e ON e.transaction_id = t.id
  JOIN __NS__.accounts a ON a.id = e.account_id AND a.code = '1100' AND e.direction = 'credit'
 WHERE t.source_kind = 'payment' AND t.status = 'posted' AND t.source_ref LIKE 'payment:%'
   AND NOT EXISTS (SELECT 1 FROM __NS__.invoice_payments p WHERE p.transaction_id = t.id);
