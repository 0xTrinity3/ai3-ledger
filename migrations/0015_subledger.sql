-- The subledger: millions of small facts, under a general ledger that stays readable.
--
-- An agent does a thing a thousand times an hour. Posting each one as its own
-- double-entry transaction gives you a general ledger nobody can read, a trial
-- balance that takes a minute to compute, and an audit trail where the signal
-- — €4 of model spend today — is buried under a thousand rows of €0.004.
--
-- So the detail lives here and the general ledger gets a summary. This is the
-- ordinary shape of a high-volume book: a subledger of events, an aggregation
-- into periodic journals, and a consolidated statement at the end of the month
-- instead of an invoice per action.
--
-- Three things this table has that a GL entry does not:
--
--   * a **lifecycle**. A card-style authorise → reserve → capture → release, so
--     two agents cannot spend the same balance at once and an over-estimate is
--     given back rather than charged.
--   * a **counterparty and a net**. When AI3 is the marketplace rather than the
--     provider, €4 collected is €3.20 owed to the provider and €0.80 of its own
--     revenue; the event carries the split so the aggregation can post it.
--   * an **internal flag**. Two agents in the same company settling with each
--     other move budget, not money: no revenue, no expense, nothing in the
--     statutory accounts. Value has to cross a legal-entity boundary, or an
--     external resource has to be consumed, before the GL hears about it.

-- What a holder — an agent, a customer, a project — has to spend.
CREATE TABLE IF NOT EXISTS meter_balances (
  company_id      text NOT NULL,
  holder          text NOT NULL,
  currency        text NOT NULL,
  available_minor bigint NOT NULL DEFAULT 0 CHECK (available_minor >= 0),
  reserved_minor  bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, holder, currency)
);

CREATE TABLE IF NOT EXISTS meter_events (
  id                uuid PRIMARY KEY,
  company_id        text NOT NULL,
  holder            text NOT NULL,
  -- reserved: the money is held. captured: it was spent, and by how much.
  -- released: the reservation came back. void: cancelled before capture.
  status            text NOT NULL CHECK (status IN ('reserved', 'captured', 'released', 'void')),
  kind              text NOT NULL CHECK (kind IN ('usage', 'time', 'output', 'outcome')),
  counterparty      text NULL,
  internal          boolean NOT NULL DEFAULT false,
  sku               text NULL,
  quantity          numeric(20, 6) NULL,
  unit_amount_minor bigint NULL,
  -- While reserved this is the ceiling; at capture it becomes what was spent.
  amount_minor      bigint NOT NULL DEFAULT 0 CHECK (amount_minor >= 0),
  reserved_minor    bigint NOT NULL DEFAULT 0 CHECK (reserved_minor >= 0),
  -- Of `amount_minor`, what belongs to somebody else. The remainder is ours.
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
  -- The caller's own key, so a retry reserves once.
  reference         text NULL,
  -- Null until it has been rolled into a general-ledger journal.
  batch_id          uuid NULL,
  created_by        text NOT NULL DEFAULT 'system'
);

CREATE UNIQUE INDEX IF NOT EXISTS meter_events_reference ON meter_events (company_id, reference) WHERE reference IS NOT NULL;
CREATE INDEX IF NOT EXISTS meter_events_unposted ON meter_events (company_id, status, batch_id);
CREATE INDEX IF NOT EXISTS meter_events_holder ON meter_events (company_id, holder, occurred_at);
CREATE INDEX IF NOT EXISTS meter_events_when ON meter_events (company_id, occurred_at);

-- One row per aggregation: which window was rolled up, into which transaction.
CREATE TABLE IF NOT EXISTS meter_batches (
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

CREATE INDEX IF NOT EXISTS meter_batches_company ON meter_batches (company_id, to_at);
