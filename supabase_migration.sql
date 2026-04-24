-- Create ai_usage table for tracking daily quotas per user
CREATE TABLE IF NOT EXISTS ai_usage (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model       text NOT NULL DEFAULT 'gemini-1.5-flash',
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Index for fast daily quota lookups
CREATE INDEX IF NOT EXISTS ai_usage_user_date_idx ON ai_usage(user_id, created_at);

-- Row Level Security: users can only see their own usage
ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users see own usage" ON ai_usage
  FOR SELECT USING (auth.uid() = user_id);

-- Service role can insert (backend uses service key)
CREATE POLICY IF NOT EXISTS "Service role insert" ON ai_usage
  FOR INSERT WITH CHECK (true);

-- Profiles table: ensure plan column exists
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS paypal_order_id text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_activated_at timestamptz;

-- Shoutouts table for Elite users
CREATE TABLE IF NOT EXISTS shoutouts (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE shoutouts ENABLE ROW LEVEL SECURITY;

-- Anyone can read shoutouts (shown to all logged-in users)
CREATE POLICY IF NOT EXISTS "Anyone can read shoutouts" ON shoutouts
  FOR SELECT USING (true);
