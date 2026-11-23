-- Supabase project usage monitor for My Learning Hub.
-- Run this once in Supabase Dashboard -> SQL Editor as a database owner.
-- The function is intentionally executable only by service_role and runs with
-- the caller's privileges; the browser calls an authenticated Edge Function.

CREATE OR REPLACE FUNCTION public.get_project_usage()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT pg_catalog.jsonb_build_object(
    'database_bytes', COALESCE((
      SELECT SUM(pg_catalog.pg_database_size(d.datname))::bigint
      FROM pg_catalog.pg_database AS d
    ), 0),
    'workspace_table_bytes', COALESCE(
      pg_catalog.pg_total_relation_size(
        pg_catalog.to_regclass('public.embedded_learning_workspaces')
      ),
      0
    ),
    'storage_bytes', COALESCE((
      SELECT SUM(
        CASE
          WHEN (o.metadata ->> 'size') ~ '^[0-9]+$'
            THEN (o.metadata ->> 'size')::bigint
          ELSE 0::bigint
        END
      )::bigint
      FROM storage.objects AS o
    ), 0),
    'storage_file_count', COALESCE((
      SELECT COUNT(*)::bigint FROM storage.objects AS o
    ), 0),
    'measured_at', pg_catalog.now()
  );
$$;

COMMENT ON FUNCTION public.get_project_usage() IS
  'Privileged project capacity metrics; invoke only from the allowlisted usage-monitor Edge Function.';

REVOKE ALL ON FUNCTION public.get_project_usage() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_project_usage() FROM anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_usage() TO service_role;
