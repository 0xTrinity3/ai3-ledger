-- AI3 Ledger — schema v1.
-- Runs inside the plugin's own PostgreSQL schema (the host sets search_path).
-- Money is bigint minor units. The ledger is append-only and every transaction sums to zero;
-- both are enforced here, not just in code.

CREATE TABLE IF NOT EXISTS accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id     uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id    text NOT NULL,
  code          text NOT NULL,
  name          text NOT NULL,
  type          text NOT NULL CHECK (type IN ('asset','liability','income','expense','equity')),
  parent_id     uuid NULL REFERENCES accounts(id),
  currency      text NOT NULL,
  is_system     boolean NOT NULL DEFAULT false,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code),
  UNIQUE (public_id)
);

CREATE TABLE IF NOT EXISTS periods (
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

CREATE TABLE IF NOT EXISTS transactions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id      text NOT NULL,
  occurred_at     timestamptz NOT NULL,
  description     text NOT NULL DEFAULT '',
  source_platform text NOT NULL,
  source_kind     text NOT NULL CHECK (source_kind IN ('cost_sweep','funding','invoice','payment','manual','reversal')),
  source_ref      text NULL,
  period_id       uuid NULL REFERENCES periods(id),
  reverses_id     uuid NULL REFERENCES transactions(id),
  created_by      text NOT NULL DEFAULT 'system',
  created_at      timestamptz NOT NULL DEFAULT now(),
  -- 'pending' exists for hosts whose SQL API cannot write a transaction and its
  -- entries in one statement (the Paperclip plugin sandbox). Reports only ever
  -- count 'posted' rows. ledger_post() writes 'posted' directly.
  status          text NOT NULL DEFAULT 'posted' CHECK (status IN ('pending','posted')),
  UNIQUE (public_id)
);

-- Idempotency: one transaction per external source record, per company and platform.
CREATE UNIQUE INDEX IF NOT EXISTS transactions_source_uniq
  ON transactions (company_id, source_platform, source_kind, source_ref)
  WHERE source_ref IS NOT NULL;

CREATE INDEX IF NOT EXISTS transactions_company_occurred
  ON transactions (company_id, occurred_at);

CREATE TABLE IF NOT EXISTS entries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id      uuid NOT NULL REFERENCES transactions(id),
  account_id          uuid NOT NULL REFERENCES accounts(id),
  subject_agent_ref   text NULL,
  subject_project_ref text NULL,
  subject_goal_ref    text NULL,
  subject_work_ref    text NULL,
  direction           text NOT NULL CHECK (direction IN ('debit','credit')),
  amount_minor        bigint NOT NULL CHECK (amount_minor > 0),
  currency            text NOT NULL
);

CREATE INDEX IF NOT EXISTS entries_transaction ON entries (transaction_id);
CREATE INDEX IF NOT EXISTS entries_account ON entries (account_id);
CREATE INDEX IF NOT EXISTS entries_agent ON entries (subject_agent_ref) WHERE subject_agent_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS treasury_allocations (
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
  ON treasury_allocations (company_id, subject_agent_ref) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS customers (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id    uuid NOT NULL DEFAULT gen_random_uuid(),
  company_id   text NOT NULL,
  name         text NOT NULL,
  email        text NULL,
  external_ref text NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (public_id)
);

CREATE TABLE IF NOT EXISTS invoices (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id          uuid NOT NULL DEFAULT gen_random_uuid(),
  share_token        text NULL,
  company_id         text NOT NULL,
  customer_id        uuid NOT NULL REFERENCES customers(id),
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

CREATE UNIQUE INDEX IF NOT EXISTS invoices_share_token ON invoices (share_token) WHERE share_token IS NOT NULL;

CREATE TABLE IF NOT EXISTS invoice_lines (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        uuid NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position          integer NOT NULL,
  description       text NOT NULL,
  quantity          numeric(18,4) NOT NULL DEFAULT 1,
  unit_amount_minor bigint NOT NULL,
  amount_minor      bigint NOT NULL,
  UNIQUE (invoice_id, position)
);

CREATE TABLE IF NOT EXISTS sweep_cursor (
  company_id       text NOT NULL,
  source_platform  text NOT NULL,
  last_event_ref   text NULL,
  last_occurred_at timestamptz NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, source_platform)
);

-- ---------------------------------------------------------------------------
-- Invariant 1: every transaction sums to zero (debits = credits).
-- Deferred constraint trigger so a multi-row insert is checked once, at commit.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_assert_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  tx uuid;
  net bigint;
  n   integer;
BEGIN
  tx := COALESCE(NEW.transaction_id, OLD.transaction_id);
  SELECT COALESCE(SUM(CASE direction WHEN 'debit' THEN amount_minor ELSE -amount_minor END), 0), COUNT(*)
    INTO net, n
    FROM entries WHERE transaction_id = tx;
  IF n < 2 THEN
    RAISE EXCEPTION 'ledger: transaction % needs at least two entries', tx
      USING ERRCODE = 'check_violation';
  END IF;
  IF net <> 0 THEN
    RAISE EXCEPTION 'ledger: transaction % does not balance (net %)', tx, net
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS entries_balanced ON entries;
CREATE CONSTRAINT TRIGGER entries_balanced
  AFTER INSERT ON entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ledger_assert_balanced();

-- ---------------------------------------------------------------------------
-- Invariant 2: the ledger is append-only. Corrections are reversing transactions.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'ledger: % on % is not allowed; post a reversal instead', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

DROP TRIGGER IF EXISTS transactions_append_only ON transactions;
CREATE TRIGGER transactions_append_only
  BEFORE UPDATE OR DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

DROP TRIGGER IF EXISTS entries_append_only ON entries;
CREATE TRIGGER entries_append_only
  BEFORE UPDATE OR DELETE ON entries
  FOR EACH ROW EXECUTE FUNCTION ledger_append_only();

-- ---------------------------------------------------------------------------
-- Invariant 3: a closed period accepts no new transactions dated inside it.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_period_open() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  closed_name text;
BEGIN
  SELECT starts_on::text || '..' || ends_on::text INTO closed_name
    FROM periods
   WHERE company_id = NEW.company_id
     AND status = 'closed'
     AND NEW.occurred_at::date BETWEEN starts_on AND ends_on
   LIMIT 1;
  IF closed_name IS NOT NULL THEN
    RAISE EXCEPTION 'ledger: period % is closed', closed_name
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS transactions_period_open ON transactions;
CREATE TRIGGER transactions_period_open
  BEFORE INSERT ON transactions
  FOR EACH ROW EXECUTE FUNCTION ledger_period_open();

-- ---------------------------------------------------------------------------
-- Posting. One function call inserts the transaction and all of its entries,
-- so the write is atomic even though the plugin database API has no
-- transaction control and only allows SELECT through `query`.
--
-- Returns one row. `inserted = false` means the (company, platform, kind, ref)
-- tuple already existed and nothing was written: the caller treats that as a
-- successful no-op, which is what makes the cost sweep idempotent.
--
-- p_entries is a JSON array of
--   { "code": "5000", "direction": "debit", "amount": "1234",
--     "agent": "...", "project": "...", "goal": "...", "work": "..." }
-- amounts are decimal strings of minor units.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ledger_post(
  p_company_id      text,
  p_occurred_at     timestamptz,
  p_description     text,
  p_source_platform text,
  p_source_kind     text,
  p_source_ref      text,
  p_created_by      text,
  p_reverses_id     uuid,
  p_currency        text,
  p_entries         jsonb
) RETURNS TABLE (id uuid, public_id uuid, inserted boolean)
LANGUAGE plpgsql AS $$
DECLARE
  v_id        uuid;
  v_public_id uuid;
  v_expected  integer;
  v_written   integer;
BEGIN
  IF jsonb_typeof(p_entries) <> 'array' OR jsonb_array_length(p_entries) < 2 THEN
    RAISE EXCEPTION 'ledger: a transaction needs at least two entries' USING ERRCODE = 'check_violation';
  END IF;
  v_expected := jsonb_array_length(p_entries);

  INSERT INTO transactions (company_id, occurred_at, description, source_platform, source_kind, source_ref, created_by, reverses_id)
  VALUES (p_company_id, p_occurred_at, COALESCE(p_description, ''), p_source_platform, p_source_kind, p_source_ref, COALESCE(p_created_by, 'system'), p_reverses_id)
  ON CONFLICT (company_id, source_platform, source_kind, source_ref) WHERE source_ref IS NOT NULL DO NOTHING
  RETURNING transactions.id, transactions.public_id INTO v_id, v_public_id;

  IF v_id IS NULL THEN
    -- Duplicate source_ref: report the existing row and write nothing.
    SELECT t.id, t.public_id INTO v_id, v_public_id
      FROM transactions t
     WHERE t.company_id = p_company_id AND t.source_platform = p_source_platform
       AND t.source_kind = p_source_kind AND t.source_ref = p_source_ref;
    RETURN QUERY SELECT v_id, v_public_id, false;
    RETURN;
  END IF;

  INSERT INTO entries (transaction_id, account_id, subject_agent_ref, subject_project_ref, subject_goal_ref, subject_work_ref, direction, amount_minor, currency)
  SELECT v_id, a.id, e.agent, e.project, e.goal, e.work, e.direction, e.amount, p_currency
    FROM jsonb_to_recordset(p_entries)
         AS e(code text, direction text, amount bigint, agent text, project text, goal text, work text)
    JOIN accounts a ON a.company_id = p_company_id AND a.code = e.code;

  GET DIAGNOSTICS v_written = ROW_COUNT;
  IF v_written <> v_expected THEN
    RAISE EXCEPTION 'ledger: % of % entries referenced an unknown account code for company %', v_expected - v_written, v_expected, p_company_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  -- The deferred balance trigger fires at the end of this statement.
  RETURN QUERY SELECT v_id, v_public_id, true;
END $$;
