-- Generated from plugin-sql/0013_credit_notes.sql for namespace plugin_ai3_ledger_2571fd243c. Do not edit.

ALTER TABLE plugin_ai3_ledger_2571fd243c.invoice_payments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'payment';
ALTER TABLE plugin_ai3_ledger_2571fd243c.invoice_payments DROP CONSTRAINT IF EXISTS invoice_payments_kind_check;
ALTER TABLE plugin_ai3_ledger_2571fd243c.invoice_payments ADD CONSTRAINT invoice_payments_kind_check CHECK (kind IN ('payment', 'credit'));

ALTER TABLE plugin_ai3_ledger_2571fd243c.invoice_payments ADD COLUMN IF NOT EXISTS reason text;
