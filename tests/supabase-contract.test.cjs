const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const sql = fs.readFileSync(path.join(root, 'supabase/sql/workspace-schema.sql'), 'utf8');
const sync = fs.readFileSync(path.join(root, 'sync-client.js'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('workspace SQL defines the client contract', () => {
  assert.match(sql, /create table if not exists public\.embedded_learning_workspaces/i);
  assert.match(sql, /user_id uuid primary key references auth\.users/i);
  assert.match(sql, /state jsonb not null/i);
  assert.match(sql, /revision bigint not null/i);
  assert.match(sql, /add constraint embedded_learning_workspaces_user_id_unique unique \(user_id\)/i);
  assert.match(sql, /foreign key \(user_id\) references auth\.users \(id\) on delete cascade/i);
  assert.match(sql, /updated_at timestamptz not null/i);
});

test('workspace SQL enables owner-only RLS and omits client DELETE', () => {
  assert.match(sql, /enable row level security/i);
  assert.match(sql, /for select\s+to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /for insert\s+to authenticated\s+with check \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /for update\s+to authenticated\s+using \(\(select auth\.uid\(\)\) = user_id\)/i);
  assert.match(sql, /revoke all on table public\.embedded_learning_workspaces from public, anon, authenticated, service_role/i);
  assert.doesNotMatch(sql, /create policy[\s\S]{0,160}for delete/i);
});

test('workspace SQL adds the table to Supabase Realtime idempotently', () => {
  assert.match(sql, /alter publication supabase_realtime\s+add table public\.embedded_learning_workspaces/i);
  assert.match(sql, /pg_catalog\.pg_publication_tables/i);
});

test('sync client retains revision compare-and-swap and per-user filtering', () => {
  assert.match(sync, /\.eq\('user_id', user\.id\)\.eq\('revision', expectedRevision\)/);
  assert.match(sync, /\.eq\('user_id', user\.id\)\.eq\('revision', row\.revision\)/);
  assert.match(sync, /filter: 'user_id=eq\.' \+ user\.id/);
});

test('recovery mode blocks save, cloud read-apply, and exposes original-data export', () => {
  assert.match(app, /if\(workspaceRecovery\.active\)\{showToast\('本地数据处于恢复保护模式/);
  assert.match(app, /normalizeWorkspaceState\(saved,true\)/);
  assert.match(app, /workspaceRecovery\.active&&typeof workspaceRecovery\.raw==='string'&&!workspaceRecovery\.originalExported/);
  assert.match(app, /recovery-export-original/);
  assert.match(app, /if\(workspaceRecovery\.active\)throw new Error\('本机工作区处于恢复保护模式/);
  assert.match(sync, /isRecoveryMode\(\)/);
});
