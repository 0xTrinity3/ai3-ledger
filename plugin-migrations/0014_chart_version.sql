-- Generated from plugin-sql/0014_chart_version.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS chart_version integer NOT NULL DEFAULT 1;
