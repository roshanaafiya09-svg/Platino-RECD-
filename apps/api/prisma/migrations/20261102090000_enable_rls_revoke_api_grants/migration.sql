-- Security hardening: close the Supabase Data API (PostgREST) off from the application's tables.
--
-- WHY: Supabase exposes every table of the "public" schema through its REST/GraphQL API to the roles "anon" and "authenticated",
-- and by default grants those roles full privileges on new tables. Earlier migrations enabled Row Level Security on only 21 of
-- the 51 application tables (the rest relied on an out-of-band Supabase change), so on a fresh Supabase project the other 30
-- tables - including "User", "Order", "OtpCode", "ServiceReport" - would be readable/writable with the public anon key.
--
-- WHAT THIS DOES (all idempotent, ADDITIVE - no table, column, data or existing policy is changed):
--   1. Enables Row Level Security on every ordinary table of the "public" schema that does not have it yet (including Prisma's
--      "_prisma_migrations"). No policy is created, so for any role that is subject to RLS the default is "deny everything".
--   2. Revokes all privileges on the public schema's tables, sequences and functions from "anon" and "authenticated" - but only
--      if those roles exist, so the migration runs unchanged on ordinary PostgreSQL where they do not.
--   3. Revokes those roles' default privileges for objects created later by the migrating role, so tables added by future
--      migrations are private from the start.
--
-- WHAT IS DELIBERATELY NOT DONE:
--   * No policies: the application never uses the Data API (it connects with Prisma as the database owner), so nothing needs one.
--   * No FORCE ROW LEVEL SECURITY: the owner must keep its access, and the owner (the "postgres" role on Supabase has BYPASSRLS,
--     and a table owner is exempt from RLS unless FORCE is set) is exactly what Prisma connects as.
--   * "service_role" is left untouched (server-side Supabase key; it bypasses RLS).
--
-- Rollback (not recommended): ALTER TABLE ... DISABLE ROW LEVEL SECURITY and re-GRANT to anon/authenticated.

DO $$
DECLARE
  t record;
BEGIN
  -- 1. RLS on every ordinary table that lacks it.
  FOR t IN
    SELECT c.relname
    FROM pg_class c
    WHERE c.relnamespace = 'public'::regnamespace
      AND c.relkind IN ('r', 'p')
      AND NOT c.relrowsecurity
  LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t.relname);
  END LOOP;
END
$$;

DO $$
DECLARE
  r text;
BEGIN
  -- 2./3. Take the Supabase API roles' privileges away, where those roles exist.
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM %I', r);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON SEQUENCES FROM %I', r);
      EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM %I', r);
    END IF;
  END LOOP;
END
$$;
