CREATE TABLE IF NOT EXISTS __NS__.suppliers (
  id                   uuid PRIMARY KEY,
  public_id            uuid NOT NULL,
  company_id           text NOT NULL,
  name                 text NOT NULL,
  email                text NULL,
  external_ref         text NULL,
  default_account_code text NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS suppliers_company ON __NS__.suppliers (company_id, name);

CREATE TABLE IF NOT EXISTS __NS__.bills (
  id                  uuid PRIMARY KEY,
  public_id           uuid NOT NULL,
  company_id          text NOT NULL,
  supplier_id         uuid NOT NULL REFERENCES __NS__.suppliers(id),
  number              text NOT NULL,
  reference           text NULL,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','part_paid','paid','void')),
  currency            text NOT NULL,
  base_currency       text NOT NULL,
  rate_to_base        numeric(20,10) NOT NULL DEFAULT 1,
  issued_at           timestamptz NULL,
  due_at              timestamptz NULL,
  subtotal_minor      bigint NOT NULL DEFAULT 0,
  tax_minor           bigint NOT NULL DEFAULT 0,
  total_minor         bigint NOT NULL DEFAULT 0,
  base_total_minor    bigint NOT NULL DEFAULT 0,
  opening_paid_minor  bigint NOT NULL DEFAULT 0,
  conversion          boolean NOT NULL DEFAULT false,
  notes               text NULL,
  subject_work_ref    text NULL,
  subject_goal_ref    text NULL,
  subject_agent_ref   text NULL,
  subject_project_ref text NULL,
  transaction_id      uuid NULL REFERENCES __NS__.transactions(id),
  approved_at         timestamptz NULL,
  created_by          text NOT NULL DEFAULT 'board',
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS bills_company_status ON __NS__.bills (company_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS __NS__.bill_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id           uuid NOT NULL REFERENCES __NS__.bills(id),
  position          integer NOT NULL,
  description       text NOT NULL,
  quantity          numeric(14,4) NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  amount_minor      bigint NOT NULL,
  tax_minor         bigint NOT NULL DEFAULT 0,
  account_code      text NOT NULL
);

CREATE INDEX IF NOT EXISTS bill_lines_bill ON __NS__.bill_lines (bill_id);

CREATE TABLE IF NOT EXISTS __NS__.bill_payments (
  id              uuid PRIMARY KEY,
  company_id      text NOT NULL,
  bill_id         uuid NOT NULL REFERENCES __NS__.bills(id),
  transaction_id  uuid NULL REFERENCES __NS__.transactions(id),
  occurred_at     timestamptz NOT NULL,
  amount_minor    bigint NOT NULL,
  rate_to_base    numeric(20,10) NOT NULL DEFAULT 1,
  base_minor      bigint NOT NULL,
  reference       text NULL,
  cash_account_code text NOT NULL DEFAULT '1000',
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (bill_id, reference)
);

CREATE INDEX IF NOT EXISTS bill_payments_bill ON __NS__.bill_payments (bill_id);

CREATE TABLE IF NOT EXISTS __NS__.documents (
  id          uuid PRIMARY KEY,
  public_id   uuid NOT NULL,
  company_id  text NOT NULL,
  filename    text NOT NULL,
  mime        text NOT NULL,
  size_bytes  integer NOT NULL,
  sha256      text NOT NULL,
  kind        text NOT NULL DEFAULT 'attachment',
  content     bytea NOT NULL,
  uploaded_by text NOT NULL DEFAULT 'board',
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, sha256),
  UNIQUE (public_id)
);

CREATE TABLE IF NOT EXISTS __NS__.document_links (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  text NOT NULL,
  document_id uuid NOT NULL REFERENCES __NS__.documents(id),
  target_kind text NOT NULL,
  target_id   text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS document_links_target ON __NS__.document_links (company_id, target_kind, target_id);

ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS tax_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS opening_paid_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS conversion boolean NOT NULL DEFAULT false;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS reference text NULL;
ALTER TABLE __NS__.invoice_lines ADD COLUMN IF NOT EXISTS tax_minor bigint NOT NULL DEFAULT 0;
ALTER TABLE __NS__.invoice_lines ADD COLUMN IF NOT EXISTS account_code text NULL;
ALTER TABLE __NS__.company_settings ADD COLUMN IF NOT EXISTS conversion_date date NULL;
