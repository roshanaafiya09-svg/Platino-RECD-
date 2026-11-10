-- Hardening only: pins the search_path of the five trigger functions that protect signed reports and ticket/site levels
-- (Supabase security advisor "function search_path mutable"). A function whose search_path is not pinned resolves table names through
-- whatever path the CALLER has, which can let a caller who can create objects in another schema shadow a table the function relies on.
-- Pinning it to the application schema (plus pg_temp last) removes that. Function bodies are NOT changed and no data is touched.
-- Rollback: ALTER FUNCTION "<name>"() RESET search_path; for each function below.

ALTER FUNCTION "service_report_signed_is_final"() SET search_path = public, pg_temp;
ALTER FUNCTION "complaint_site_level_guard"() SET search_path = public, pg_temp;
ALTER FUNCTION "service_report_final_no_delete"() SET search_path = public, pg_temp;
ALTER FUNCTION "report_file_referenced_is_final"() SET search_path = public, pg_temp;
ALTER FUNCTION "service_report_event_final_is_append_only"() SET search_path = public, pg_temp;
