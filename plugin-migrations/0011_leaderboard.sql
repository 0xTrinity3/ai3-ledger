-- Generated from plugin-sql/0011_leaderboard.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS leaderboard_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS leaderboard_opted_at timestamptz NULL;
ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS summary_published_at timestamptz NULL;
