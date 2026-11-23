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


test('Storage SQL creates a private bucket with per-user object policies', () => {
  const storageSql = fs.readFileSync(path.join(root, 'supabase/sql/storage-media.sql'), 'utf8');
  assert.match(storageSql, /insert into storage\.buckets/i);
  assert.match(storageSql, /'knowledge-media'[\s\S]{0,100}'knowledge-media'[\s\S]{0,50}false/i);
  assert.match(storageSql, /for select\s+to authenticated\s+using\s*\([\s\S]*bucket_id = 'knowledge-media'[\s\S]*storage\.foldername\(name\)\)\[1\] = \(select auth\.uid\(\)\)::text/i);
  assert.match(storageSql, /for insert\s+to authenticated\s+with check/i);
  assert.match(storageSql, /for update\s+to authenticated\s+using[\s\S]*with check/i);
  assert.match(storageSql, /for delete\s+to authenticated\s+using/i);
  assert.doesNotMatch(storageSql, /public\s*=\s*true/i);
});

test('browser sync uploads and signs private Storage media, then migrates legacy Base64 HTML', () => {
  assert.match(sync, /client\.storage\.from\(STORAGE_BUCKET\)\.upload/);
  assert.match(sync, /createSignedUrl\(path,\s*SIGNED_URL_TTL/);
  assert.match(sync, /async function migrateStateInlineMedia/);
  assert.match(sync, /async function migrateCloudRowMedia/);
  assert.match(sync, /prepareStateForStorage\(getAppStateOrThrow\(\)\)/);
  assert.match(sync, /supabase-storage:\/\/' \+ STORAGE_BUCKET/);
  assert.match(app, /supabase-storage:\\\/\\\/knowledge-media/);
  assert.match(app, /data-storage-ref/);
  assert.match(app, /uploadMediaFile\(file,mime\)/);
});

test('Storage cleanup scans only the authenticated user tree and deletes through the Storage API', () => {
  assert.match(sync, /async function listStorageObjectsRecursive/);
  assert.match(sync, /String\(user\.id\)\.toLowerCase\(\) \+ '\/'/);
  assert.match(sync, /client\.storage\.from\(STORAGE_BUCKET\)\.list\(folderPath/);
  assert.match(sync, /client\.storage\.from\(STORAGE_BUCKET\)\.remove\(batch\)/);
  assert.match(sync, /index \+= 1000/);
  assert.match(sync, /async function scanStorageCleanup/);
  assert.match(sync, /async function cleanupOrphanedStorage/);
  assert.match(sync, /collectStorageMediaReferences\(row\.state, referencedPaths\)/);
  assert.match(sync, /getPendingUndoMediaReferences/);
  assert.match(sync, /getActiveEditorStorageMediaReferences/);
  assert.match(app, /data-action="scan-storage"/);
  assert.match(app, /data-action="cleanup-storage"/);
  assert.match(app, /renderStorageCleanupPanel\(ss\)/);
});

test('module deletion keeps attachments during undo and reclaims only after undo expiry', () => {
  assert.match(app, /const mediaBefore=collectWorkspaceStorageMediaReferences\(undoBefore\)/);
  assert.match(app, /const mediaAfter=collectWorkspaceStorageMediaReferences\(state\)/);
  assert.match(app, /mediaCandidates=Array\.from\(mediaBefore\)\.filter\(reference=>!mediaAfter\.has\(reference\)\)/);
  assert.match(app, /cleanupExpiredStorageMedia\(entry\)/);
  assert.match(app, /removePendingUndoEntry\(id\);persistPendingDeleteUndos\(\);cleanupExpiredStorageMedia\(entry\)/);
  assert.match(app, /getPendingUndoMediaReferences:\(\)=>Array\.from\(new Set\(pendingDeleteUndos\.flatMap/);
  assert.match(app, /getActiveEditorStorageMediaReferences:\(\)=>\{const refs=new Set\(\);document\.querySelectorAll/);
  assert.match(sync, /pendingUndoReferences\.forEach\(reference =>/);
});
