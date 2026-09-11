-- Generated from plugin-sql/0005_reminders.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

ALTER TABLE plugin_ai3_ledger_2571fd243c.company_settings ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE plugin_ai3_ledger_2571fd243c.invoices ADD COLUMN IF NOT EXISTS reminder_stage integer NOT NULL DEFAULT 0;
ALTER TABLE plugin_ai3_ledger_2571fd243c.invoices ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz NULL;
