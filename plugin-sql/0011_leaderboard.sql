-- Publishing the company's figures to ai3.co: the opt-in to the public
-- leaderboard, and when the summary was last pushed.
ALTER TABLE __NS__.company_settings ADD COLUMN IF NOT EXISTS leaderboard_opt_in boolean NOT NULL DEFAULT false;
ALTER TABLE __NS__.company_settings ADD COLUMN IF NOT EXISTS leaderboard_opted_at timestamptz NULL;
ALTER TABLE __NS__.company_settings ADD COLUMN IF NOT EXISTS summary_published_at timestamptz NULL;
