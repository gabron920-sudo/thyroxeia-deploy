-- ══════════════════════════════════════════════════════════════════════════════
--  HeyMino — live database hardening (matches the ACTUAL schema in project
--  odyywykbaahgmnvashrs). Idempotent: safe to run again.
--
--  What this fixes, in order of severity:
--   1. profiles + ai_usage had a policy granting ALL commands to PUBLIC with
--      qual=true  ->  anyone with the anon key could read/rewrite EVERY row
--      (set anyone to 'elite', wipe profiles, reset AI quotas).
--   2. ai_usage had columns (date, count) but the Worker writes
--      (model, created_at)  ->  every quota query errored and daily limits
--      were silently never enforced.
--   3. No guard on billing columns (if a client UPDATE policy is ever added).
--   4. paypal_subscription_id was indexed but not unique.
--   5. paypal_plans and otp_codes tables were missing.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1. ai_usage: make the columns the Worker actually uses exist ──────────────
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS model text;
ALTER TABLE ai_usage ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_usage' AND column_name = 'date'
  ) THEN
    EXECUTE 'UPDATE ai_usage SET created_at = COALESCE(created_at, date::timestamptz) WHERE created_at IS NULL';
  END IF;
END $$;

ALTER TABLE ai_usage ALTER COLUMN created_at SET DEFAULT now();
-- `date` is a legacy NOT NULL column with no default: without this, every INSERT the
-- Worker makes (user_id, model, created_at) fails, so daily quotas were never enforced.
ALTER TABLE ai_usage ALTER COLUMN date SET DEFAULT CURRENT_DATE;
-- Legacy rows (written before `model` existed) get their real date, not the now() that
-- ADD COLUMN filled in, so old usage is not counted against today's quota.
UPDATE ai_usage SET created_at = date::timestamptz WHERE model IS NULL AND date IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_usage_user_created_idx ON ai_usage (user_id, created_at);

-- ── 2. profiles: remove the world-writable policy ────────────────────────────
DROP POLICY IF EXISTS service_full ON profiles;
DROP POLICY IF EXISTS "Service role full access profiles" ON profiles;
CREATE POLICY profile_service_all ON profiles
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

-- The app reads its own plan with the anon key, so it needs exactly this.
DROP POLICY IF EXISTS "Users see own profile" ON profiles;
CREATE POLICY "Users see own profile" ON profiles
  FOR SELECT USING (auth.uid() = id);

-- Deliberately NO client UPDATE policy: the app never writes profiles from the
-- browser. If you ever add one, the trigger below keeps billing columns safe.
DROP POLICY IF EXISTS "Users update own profile" ON profiles;

-- ── 3. billing columns are server-write-only ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.protect_profile_billing_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  claims     text;
  jwt_role   text;
  is_service boolean;
BEGIN
  claims := current_setting('request.jwt.claims', true);
  BEGIN
    jwt_role := CASE
                  WHEN claims IS NULL OR claims = '' THEN NULL
                  ELSE (claims::jsonb) ->> 'role'
                END;
  EXCEPTION WHEN others THEN
    jwt_role := NULL;
  END;

  is_service := COALESCE(jwt_role, '') = 'service_role'
             OR COALESCE(current_setting('role', true), '') = 'service_role'
             OR current_user IN ('postgres', 'supabase_admin', 'service_role');

  IF is_service THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.plan, 'free') <> 'free'
       OR NEW.paypal_subscription_id IS NOT NULL
       OR NEW.subscription_plan IS NOT NULL THEN
      RAISE EXCEPTION 'Billing fields are managed by the server and cannot be set by a client.'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.plan                     IS DISTINCT FROM OLD.plan
     OR NEW.paypal_subscription_id IS DISTINCT FROM OLD.paypal_subscription_id
     OR NEW.subscription_plan     IS DISTINCT FROM OLD.subscription_plan
     OR NEW.subscription_status   IS DISTINCT FROM OLD.subscription_status
     OR NEW.subscription_started_at IS DISTINCT FROM OLD.subscription_started_at
     OR NEW.subscription_checked_at IS DISTINCT FROM OLD.subscription_checked_at
     OR NEW.current_period_end    IS DISTINCT FROM OLD.current_period_end
     OR NEW.paypal_order_id       IS DISTINCT FROM OLD.paypal_order_id
     OR NEW.plan_activated_at     IS DISTINCT FROM OLD.plan_activated_at THEN
    RAISE EXCEPTION 'Billing fields are managed by the server and cannot be changed by a client.'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_profile_billing ON public.profiles;
CREATE TRIGGER protect_profile_billing
  BEFORE INSERT OR UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.protect_profile_billing_columns();

-- ── 4. one PayPal subscription = one account ─────────────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS profiles_paypal_subscription_uidx
  ON public.profiles (paypal_subscription_id)
  WHERE paypal_subscription_id IS NOT NULL;

-- ── 5. ai_usage policies: service role writes, users read their own ──────────
DROP POLICY IF EXISTS service_full_ai ON ai_usage;
DROP POLICY IF EXISTS sroi ON ai_usage;
DROP POLICY IF EXISTS "Service role only insert" ON ai_usage;

CREATE POLICY ai_usage_service_all ON ai_usage
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE POLICY "Users see own usage" ON ai_usage
  FOR SELECT USING (auth.uid() = user_id);

-- ── 6. shoutouts: public read is intended, public INSERT is not ──────────────
DROP POLICY IF EXISTS service_insert ON shoutouts;
CREATE POLICY shoutouts_service_insert ON shoutouts
  FOR INSERT WITH CHECK (auth.role() = 'service_role');

-- ── 7. PayPal plan catalog (service role only) ───────────────────────────────
CREATE TABLE IF NOT EXISTS paypal_plans (
  plan_id    text PRIMARY KEY,
  plan       text NOT NULL CHECK (plan IN ('student', 'pro', 'elite')),
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE paypal_plans ENABLE ROW LEVEL SECURITY;

-- ── 8. otp_codes (missing entirely) ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS otp_codes (
  id         uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE UNIQUE,
  email      text NOT NULL,
  otp_hash   text NOT NULL,
  expires_at timestamptz NOT NULL,
  used       boolean NOT NULL DEFAULT false,
  attempts   integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE otp_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

DROP POLICY IF EXISTS "Service role manages OTPs" ON otp_codes;
CREATE POLICY "Service role manages OTPs" ON otp_codes
  FOR ALL
  USING (auth.role() = 'service_role')
  WITH CHECK (auth.role() = 'service_role');

CREATE INDEX IF NOT EXISTS otp_codes_expires_at_idx ON otp_codes (expires_at);

CREATE OR REPLACE FUNCTION public.cleanup_expired_otps()
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM otp_codes WHERE expires_at < now() - interval '1 hour';
$$;
