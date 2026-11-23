-- Manual RLS smoke test. Replace the UUID with a real Auth user UUID.
-- Run the statements in one SQL Editor session. The final query must return
-- only the current user's row (zero rows is valid if that user has no workspace).
-- Do not run this as service_role: service_role bypasses RLS by design.

begin;
set local role authenticated;
select pg_catalog.set_config(
  'request.jwt.claim.sub',
  'REPLACE_WITH_AUTH_USER_UUID',
  true
);

select
  auth.uid() as effective_user_id,
  user_id,
  revision,
  updated_at
from public.embedded_learning_workspaces
order by updated_at desc;

-- This query must return 0. Any returned row indicates an RLS isolation failure.
select count(*) as visible_other_users_rows
from public.embedded_learning_workspaces
where user_id <> auth.uid();

rollback;
