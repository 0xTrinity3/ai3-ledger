ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_source_kind_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_source_kind_check CHECK (source_kind IN ('cost_sweep','funding','invoice','payment','manual','reversal','journal','bill','conversion'));

CREATE TABLE IF NOT EXISTS journals (
  id              uuid PRIMARY KEY,
  public_id       uuid NOT NULL,
  company_id      text NOT NULL,
  number          text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  narration       text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','posted','voided')),
  transaction_id  uuid NULL REFERENCES transactions(id),
  reversal_id     uuid NULL REFERENCES transactions(id),
  created_by      text NOT NULL DEFAULT 'board',
  created_at      timestamptz NOT NULL DEFAULT now(),
  posted_at       timestamptz NULL,
  voided_at       timestamptz NULL,
  voided_by       text NULL,
  UNIQUE (company_id, number),
  UNIQUE (public_id)
);

CREATE INDEX IF NOT EXISTS journals_company_status ON journals (company_id, status, occurred_at DESC);

CREATE TABLE IF NOT EXISTS journal_lines (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  journal_id          uuid NOT NULL REFERENCES journals(id),
  position            integer NOT NULL,
  account_code        text NOT NULL,
  direction           text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  description         text NULL,
  subject_agent_ref   text NULL,
  subject_project_ref text NULL,
  subject_goal_ref    text NULL
);

CREATE INDEX IF NOT EXISTS journal_lines_journal ON journal_lines (journal_id);
