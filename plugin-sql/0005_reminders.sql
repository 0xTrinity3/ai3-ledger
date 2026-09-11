ALTER TABLE __NS__.company_settings ADD COLUMN IF NOT EXISTS reminders_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS reminder_stage integer NOT NULL DEFAULT 0;
ALTER TABLE __NS__.invoices ADD COLUMN IF NOT EXISTS last_reminder_at timestamptz NULL;
