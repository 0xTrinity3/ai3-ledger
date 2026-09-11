ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS ai3_key text NULL;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS ai3_origin text NULL;
ALTER TABLE company_settings ADD COLUMN IF NOT EXISTS reply_to text NULL;

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hosted_token text NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hosted_url text NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hosted_at timestamptz NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_at timestamptz NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS sent_to text NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS opened_at timestamptz NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS open_count integer NOT NULL DEFAULT 0;
