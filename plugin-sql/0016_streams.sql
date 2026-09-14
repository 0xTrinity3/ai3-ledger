-- Continuous accrual: work that is earned by the second, not by the invoice.
--
-- An agent paid €0.01 a task and running all day is not billing anybody 300
-- times. It is earning continuously, and the balance owed to it grows as the
-- work happens — the withdrawal later only settles what was already earned.
-- That is how streaming payroll is accounted for, and it is what an agent
-- economy needs: the expense arises when the work is done, and the cash moves
-- whenever somebody asks for it.
--
-- A stream is the standing agreement. Each accrual is an ordinary subledger
-- event, so the same daily sweep that summarises usage summarises this too;
-- the difference is which side of the general ledger it lands on, which is
-- what `funding` on meter_events records:
--
--   balance   drawn from a prepaid balance      Cr customer credits
--   accrual   owed to whoever earned it         Cr accrued streams payable
--
-- Nothing here moves money. `withdraw` settles an earned balance against cash;
-- until then the accrual is a liability and says so.
ALTER TABLE __NS__.meter_events ADD COLUMN IF NOT EXISTS funding text NOT NULL DEFAULT 'balance';
ALTER TABLE __NS__.meter_events DROP CONSTRAINT IF EXISTS meter_events_funding_check;
ALTER TABLE __NS__.meter_events ADD CONSTRAINT meter_events_funding_check CHECK (funding IN ('balance', 'accrual', 'prepaid'));
ALTER TABLE __NS__.meter_events ADD COLUMN IF NOT EXISTS stream_id uuid NULL;

CREATE TABLE IF NOT EXISTS __NS__.meter_streams (
  id             uuid PRIMARY KEY,
  company_id     text NOT NULL,
  -- Who pays and who earns. Either may be an agent, a customer or another
  -- organisation; what matters is that both are named, because an accrual with
  -- no recipient is a cost with nobody to pay.
  payer          text NOT NULL,
  recipient      text NOT NULL,
  kind           text NOT NULL CHECK (kind IN ('time', 'usage', 'output', 'outcome')),
  -- What is being counted: an hour, a call, a completed task, verified value.
  meter          text NOT NULL,
  -- Per meter unit, for everything but an outcome stream.
  rate_minor     bigint NOT NULL DEFAULT 0 CHECK (rate_minor >= 0),
  -- For an outcome stream: a share of the value it is measured against.
  rate_pct       numeric(9, 4) NULL,
  currency       text NOT NULL,
  -- The ceiling, and what it is a ceiling on. A stream with no cap is a
  -- standing instruction to spend without limit, so one is always recorded.
  cap_minor      bigint NULL,
  cap_period     text NOT NULL DEFAULT 'total' CHECK (cap_period IN ('total', 'day', 'month')),
  accrued_minor  bigint NOT NULL DEFAULT 0 CHECK (accrued_minor >= 0),
  settled_minor  bigint NOT NULL DEFAULT 0 CHECK (settled_minor >= 0),
  status         text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'cancelled', 'ended')),
  internal       boolean NOT NULL DEFAULT false,
  account_code   text NOT NULL,
  -- How much notice either side has to give. Zero means it stops on the word.
  notice_seconds integer NOT NULL DEFAULT 0 CHECK (notice_seconds >= 0),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ends_at        timestamptz NULL,
  last_tick_at   timestamptz NULL,
  cancelled_at   timestamptz NULL,
  cancel_reason  text NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  created_by     text NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS meter_streams_company ON __NS__.meter_streams (company_id, status);
CREATE INDEX IF NOT EXISTS meter_streams_recipient ON __NS__.meter_streams (company_id, recipient);
CREATE INDEX IF NOT EXISTS meter_events_stream ON __NS__.meter_events (company_id, stream_id);
