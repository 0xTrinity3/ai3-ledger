-- Whether reconciliation posts by itself, and how sure it has to be.
--
-- The nightly job already ran at a hard-coded 90% for every company, which is
-- a policy about somebody's books made in our source code. It is theirs: a
-- company that wants nothing posted without a person looking turns it off, and
-- one that trusts the matcher can lower the bar. Defaults preserve exactly what
-- the job did before, so nothing changes for anyone who never opens the screen.
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS auto_reconcile boolean NOT NULL DEFAULT true;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS auto_reconcile_threshold integer NOT NULL DEFAULT 90;
