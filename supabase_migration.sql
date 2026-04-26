-- ══════════════════════════════════════════════════════════════════════════════
--  Thyroxeia AI — Supabase Migration (Security Hardened)
--  Run this in: Supabase Dashboard → SQL Editor → New Query → Run
-- ══════════════════════════════════════════════════════════════════════════════

-- ── ai_usage table ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ai_usage (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  model       text NOT NULL DEFAULT 'gemini-1.5-flash',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_usage_user_date_idx ON ai_usage(user_id, created_at);

ALTER TABLE ai_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY IF NOT EXISTS "Users see own usage" ON ai_usage
  FOR SELECT USING (auth.uid() = user_id);

-- FIX: Only service role (Railway backend) can insert — not anon clients
DROP POLICY IF EXISTS "Service role insert" ON ai_usage;
CREATE POLICY "Service role only insert" ON ai_usage
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- ── profiles table ────────────────────────────────────────────────────────────
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan text DEFAULT 'free';
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS paypal_order_id text;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS plan_activated_at timestamptz;

-- FIX: Enable RLS on profiles (was missing — anyone with anon key could read all plans)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users see own profile" ON profiles;
CREATE POLICY "Users see own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

DROP POLICY IF EXISTS "Users update own profile" ON profiles;
CREATE POLICY "Users update own profile" ON profiles
  FOR UPDATE USING (auth.uid() = id);

-- Service role (backend) can read + write all profiles
DROP POLICY IF EXISTS "Service role full access profiles" ON profiles;
CREATE POLICY "Service role full access profiles" ON profiles
  FOR ALL USING (auth.role() = 'service_role');

-- ── shoutouts table ───────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shoutouts (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  display_name text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE(user_id)
);

ALTER TABLE shoutouts ENABLE ROW LEVEL SECURITY;

-- Anyone authenticated can read shoutouts (shown on login)
DROP POLICY IF EXISTS "Anyone can read shoutouts" ON shoutouts;
CREATE POLICY "Authenticated users read shoutouts" ON shoutouts
  FOR SELECT USING (auth.role() = 'authenticated');

-- Service role inserts shoutouts
DROP POLICY IF EXISTS "Service role insert shoutouts" ON shoutouts;
CREATE POLICY "Service role insert shoutouts" ON shoutouts
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- ── otp_codes table (NEW) ─────────────────────────────────────────────────────
-- FIX: Stores server-generated OTPs securely — never passed from client
CREATE TABLE IF NOT EXISTS otp_codes (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  email       text NOT NULL,
  otp_hash    text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used        boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;

-- Only service role (backend) can read/write OTP codes — never anon
CREATE POLICY IF NOT EXISTS "Service role manages OTPs" ON otp_codes
  FOR ALL USING (auth.role() = 'service_role');

-- Auto-cleanup: delete expired OTPs (run periodically or via cron)
-- CREATE OR REPLACE FUNCTION cleanup_expired_otps() RETURNS void AS $$
--   DELETE FROM otp_codes WHERE expires_at < now();
-- $$ LANGUAGE sql SECURITY DEFINER;
