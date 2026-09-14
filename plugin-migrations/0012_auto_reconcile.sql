-- Generated from plugin-sql/0012_auto_reconcile.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS auto_reconcile boolean NOT NULL DEFAULT true;
ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS auto_reconcile_threshold integer NOT NULL DEFAULT 90;
