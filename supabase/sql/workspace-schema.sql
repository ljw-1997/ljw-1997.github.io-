-- Embedded Learning Hub workspace table, RLS policies and Realtime publication.
-- Run once in Supabase Dashboard -> SQL Editor as a database owner.
-- Safe to re-run: table/policies/publication membership are guarded or replaced.

begin;

create table if not exists public.embedded_learning_workspaces (
  user_id uuid primary key references auth.users (id) on delete cascade,
  state jsonb not null default '{}'::jsonb,
  revision bigint not null default 1,
  updated_at timestamptz not null default pg_catalog.now(),
  constraint embedded_learning_workspaces_state_is_object
    check (pg_catalog.jsonb_typeof(state) = 'object'),
  constraint embedded_learning_workspaces_revision_positive
    check (revision >= 1)
);

-- Keep older compatible installations in sync with the client contract.
alter table public.embedded_learning_workspaces
  add column if not exists state jsonb not null default '{}'::jsonb;
alter table public.embedded_learning_workspaces
  add column if not exists revision bigint not null default 1;
alter table public.embedded_learning_workspaces
  add column if not exists updated_at timestamptz not null default pg_catalog.now();

-- Enforce the Auth identity contract on pre-existing tables as well.
-- Existing orphaned IDs are not deleted: migration stops and asks for review.
do $identity$
declare
  workspace_user_type regtype;
  workspace_user_attnum smallint;
  auth_id_attnum smallint;
begin
  select a.atttypid::regtype, a.attnum
    into workspace_user_type, workspace_user_attnum
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'public.embedded_learning_workspaces'::regclass
    and a.attname = 'user_id'
    and a.attnum > 0
    and not a.attisdropped;

  if workspace_user_type is distinct from 'uuid'::regtype then
    raise exception 'embedded_learning_workspaces.user_id must be UUID; inspect and migrate the existing column manually.';
  end if;

  alter table public.embedded_learning_workspaces alter column user_id set not null;

  select a.attnum into auth_id_attnum
  from pg_catalog.pg_attribute as a
  where a.attrelid = 'auth.users'::regclass
    and a.attname = 'id'
    and a.attnum > 0
    and not a.attisdropped;

  if not exists (
    select 1 from pg_catalog.pg_constraint as c
    where c.conrelid = 'public.embedded_learning_workspaces'::regclass
      and c.confrelid = 'auth.users'::regclass
      and c.contype = 'f'
      and c.conkey = array[workspace_user_attnum]::smallint[]
      and c.confkey = array[auth_id_attnum]::smallint[]
  ) then
    if exists (
      select 1 from public.embedded_learning_workspaces as w
      left join auth.users as u on u.id = w.user_id
      where u.id is null
    ) then
      raise exception 'embedded_learning_workspaces contains user_id values not present in auth.users; review orphaned rows before applying the Auth foreign key.';
    end if;
    alter table public.embedded_learning_workspaces
      add constraint embedded_learning_workspaces_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade;
  end if;
end
$identity$;

-- Ensure the API can address exactly one workspace per Auth user even when
-- upgrading a manually-created legacy table. Refuse to proceed if duplicate
-- owners already exist: silently deleting or choosing a row would lose data.
do $uniqueness$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.embedded_learning_workspaces'::regclass
      and contype in ('p', 'u')
      and pg_catalog.pg_get_constraintdef(oid) in ('PRIMARY KEY (user_id)', 'UNIQUE (user_id)')
  ) then
    if exists (
      select user_id
      from public.embedded_learning_workspaces
      group by user_id
      having count(*) > 1
    ) then
      raise exception 'embedded_learning_workspaces contains duplicate user_id values; resolve duplicates before applying V20.0 migration.';
    end if;
    alter table public.embedded_learning_workspaces
      add constraint embedded_learning_workspaces_user_id_unique unique (user_id);
  end if;
end
$uniqueness$;

-- Add the data-shape constraints to an existing table if they are not present.
do $migration$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.embedded_learning_workspaces'::regclass
      and conname = 'embedded_learning_workspaces_state_is_object'
  ) then
    alter table public.embedded_learning_workspaces
      add constraint embedded_learning_workspaces_state_is_object
      check (pg_catalog.jsonb_typeof(state) = 'object');
  end if;

  if not exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.embedded_learning_workspaces'::regclass
      and conname = 'embedded_learning_workspaces_revision_positive'
  ) then
    alter table public.embedded_learning_workspaces
      add constraint embedded_learning_workspaces_revision_positive
      check (revision >= 1);
  end if;
end
$migration$;

comment on table public.embedded_learning_workspaces is
  'One versioned JSON workspace per Supabase Auth user for Embedded Learning Hub.';
comment on column public.embedded_learning_workspaces.state is
  'Complete user workspace JSON. The client validates its shape before applying it.';
comment on column public.embedded_learning_workspaces.revision is
  'Monotonically increasing optimistic-concurrency revision.';

alter table public.embedded_learning_workspaces enable row level security;

-- The browser client uses SELECT, INSERT and conditional UPDATE only.
-- There is deliberately no client-side DELETE policy.
drop policy if exists "workspace_select_own" on public.embedded_learning_workspaces;
create policy "workspace_select_own"
  on public.embedded_learning_workspaces
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "workspace_insert_own" on public.embedded_learning_workspaces;
create policy "workspace_insert_own"
  on public.embedded_learning_workspaces
  for insert
  to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "workspace_update_own" on public.embedded_learning_workspaces;
create policy "workspace_update_own"
  on public.embedded_learning_workspaces
  for update
  to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

revoke all on table public.embedded_learning_workspaces from public, anon, authenticated, service_role;
grant select, insert, update on table public.embedded_learning_workspaces to authenticated;

-- Supabase Realtime delivers UPDATE/INSERT events to the existing sync client.
do $realtime$
begin
  if exists (
    select 1 from pg_catalog.pg_publication
    where pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'embedded_learning_workspaces'
  ) then
    alter publication supabase_realtime
      add table public.embedded_learning_workspaces;
  end if;
end
$realtime$;

commit;
