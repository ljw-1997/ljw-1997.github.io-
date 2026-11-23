/* Supabase Auth + versioned workspace sync for the standalone GitHub Pages app. */
(function () {
  'use strict';

  const TABLE = 'embedded_learning_workspaces';
  const STORAGE_BUCKET = 'knowledge-media';
  const SIGNED_URL_TTL = 900;
  const mediaUrlCache = new Map();
  const mediaMigrationInFlight = new Map();
  const CONFIG_KEY = 'embedded-learning-hub-supabase-config-v1';
  const META_KEY = 'embedded-learning-hub-sync-meta-v1';
  const SDK = window.supabase;

  let client = null;
  let user = null;
  let authSubscription = null;
  let realtimeChannel = null;
  let realtimeUserId = '';
  let pollTimer = null;
  let pushTimer = null;
  let bootPromise = null;
  let bootUserId = '';
  let dirty = false;
  let conflictRow = null;
  let lastSnapshotFingerprint = '';
  let inFlightUpload = null;
  let pushInFlight = false;
  let pendingPush = false;
  let passwordRecoveryMode = false;
  let applyingRemote = false;
  let lastRemoteNoticeKey = '';

  const status = {
    configured: false,
    sdkReady: !!(SDK && typeof SDK.createClient === 'function'),
    user: null,
    mode: 'unconfigured',
    message: '云同步尚未配置。',
    revision: 0,
    updatedAt: null,
    error: '',
    hasLocalChanges: false
  };

  function clone(value) { return JSON.parse(JSON.stringify(value)); }
  function app() { return window.EmbeddedLearningApp || null; }
  function currentState() { const a = app(); return a ? a.getState() : null; }
  function toast(message) { const a = app(); if (a && a.notify) a.notify(message); else console.info('[EmbeddedSync]', message); }
  function localGet(key) { try { return localStorage.getItem(key); } catch (_) { return null; } }
  function localSet(key, value) { try { localStorage.setItem(key, value); return true; } catch (_) { return false; } }
  function readConfig() {
    let saved = null;
    try { saved = JSON.parse(localGet(CONFIG_KEY) || 'null'); } catch (_) {}
    const defaults = window.EMBEDDED_LEARNING_SUPABASE_CONFIG || {};
    const url = String(saved && saved.url || defaults.url || '').trim();
    const publishableKey = String(saved && (saved.publishableKey || saved.anonKey) || defaults.publishableKey || defaults.anonKey || '').trim();
    return { url, publishableKey };
  }
  function readMeta() { try { return JSON.parse(localGet(META_KEY) || 'null') || {}; } catch (_) { return {}; } }
  function writeMeta(meta) { localSet(META_KEY, JSON.stringify(meta)); }
  function stableStringify(value) {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return '[' + value.map(item => stableStringify(item) ?? 'null').join(',') + ']';
    const keys = Object.keys(value).filter(key => typeof value[key] !== 'undefined').sort();
    return '{' + keys.map(key => JSON.stringify(key) + ':' + stableStringify(value[key])).join(',') + '}';
  }
  function fingerprint(value) {
    const input = stableStringify(value);
    let hash = 2166136261;
    for (let i = 0; i < input.length; i++) { hash ^= input.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(16).padStart(8, '0') + ':' + input.length;
  }
  function emit() {
    status.configured = !!(readConfig().url && readConfig().publishableKey);
    status.sdkReady = !!(SDK && typeof SDK.createClient === 'function');
    status.user = user ? { id: user.id, email: user.email || '' } : null;
    const snapshot = { ...status, user: status.user };
    try { document.dispatchEvent(new CustomEvent('embedded-sync-status', { detail: snapshot })); } catch (_) {}
    const a = app();
    if (a && typeof a.onSyncStatusChanged === 'function') a.onSyncStatusChanged(snapshot);
  }
  function setStatus(mode, message, error) {
    status.mode = mode;
    status.message = message || '';
    status.error = error ? String(error.message || error) : '';
    emit();
  }
  function getAppStateOrThrow() {
    const a = app();
    if (a && typeof a.isRecoveryMode === 'function' && a.isRecoveryMode()) {
      throw new Error('本机工作区处于数据恢复保护模式。云同步已暂停，避免上传临时空白数据或覆盖原始内容；请先导入有效备份或明确初始化工作区。');
    }
    const value = currentState();
    if (!value || typeof value !== 'object') throw new Error('页面数据还未准备好，请刷新后重试。');
    return clone(value);
  }
  function clearTimers() {
    if (pushTimer) clearTimeout(pushTimer);
    if (pollTimer) clearInterval(pollTimer);
    pushTimer = null;
    pollTimer = null;
  }
  function closeRealtime() {
    if (realtimeChannel && client) client.removeChannel(realtimeChannel).catch(() => {});
    realtimeChannel = null;
    realtimeUserId = '';
  }
  function stopClientListeners() {
    clearTimers();
    closeRealtime();
    if (authSubscription && authSubscription.unsubscribe) authSubscription.unsubscribe();
    authSubscription = null;
  }
  function normaliseCloudRow(row) {
    if (!row || typeof row !== 'object' || !row.user_id || !row.state || typeof row.state !== 'object') return null;
    return { user_id: row.user_id, state: row.state, revision: Number(row.revision) || 1, updated_at: row.updated_at || null };
  }
  function extensionForMime(mime, filename) {
    const known = {
      'image/png':'png','image/jpeg':'jpg','image/gif':'gif','image/webp':'webp','image/avif':'avif','image/bmp':'bmp',
      'application/pdf':'pdf','text/plain':'txt','text/csv':'csv','text/markdown':'md','application/json':'json',
      'application/zip':'zip','application/gzip':'gz','application/octet-stream':'bin',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation':'pptx',
      'application/msword':'doc','application/vnd.ms-excel':'xls','application/vnd.ms-powerpoint':'ppt'
    };
    if (known[mime]) return known[mime];
    const match = String(filename || '').toLowerCase().match(/\.([a-z0-9]{1,10})$/);
    return match ? match[1] : 'bin';
  }
  function makeMediaId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return 'f' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 18);
  }
  function isStorageMediaReference(value) {
    return /^supabase-storage:\/\/knowledge-media\/[0-9a-f-]{36}\/[a-z0-9][a-z0-9._-]{0,159}$/i.test(String(value || ''));
  }
  async function uploadBlobToStorage(blob, mime, filename) {
    if (!client || !user) throw new Error('请先登录 Supabase 账号，再将图片或附件上传到 Storage。');
    if (!client.storage || typeof client.storage.from !== 'function') throw new Error('当前 Supabase SDK 未提供 Storage API，请检查 SDK 是否加载成功。');
    const safeMime = String(mime || blob.type || 'application/octet-stream').toLowerCase().split(';')[0].trim();
    const path = String(user.id).toLowerCase() + '/' + makeMediaId() + '.' + extensionForMime(safeMime, filename);
    const { data, error } = await client.storage.from(STORAGE_BUCKET).upload(path, blob, {
      cacheControl: '3600',
      contentType: safeMime,
      upsert: false
    });
    if (error) throw error;
    return 'supabase-storage://' + STORAGE_BUCKET + '/' + (data && data.path ? data.path : path);
  }
  async function uploadMediaFile(file, contentType) {
    if (!file || typeof file !== 'object') throw new Error('没有选择有效的附件文件。');
    return uploadBlobToStorage(file, contentType || file.type || 'application/octet-stream', file.name || 'attachment.bin');
  }
  async function resolveMediaUrl(reference, forceDownload, downloadName, forceRefresh) {
    if (!client || !user) throw new Error('请登录 Supabase 账号后查看私有附件。');
    const match = /^supabase-storage:\/\/knowledge-media\/([0-9a-f-]{36})\/([a-z0-9][a-z0-9._-]{0,159})$/i.exec(String(reference || ''));
    if (!match) throw new Error('附件对象引用格式无效。');
    if (match[1].toLowerCase() !== String(user.id).toLowerCase()) throw new Error('已拒绝访问其他账号的 Storage 对象。');
    const path = match[1] + '/' + match[2];
    const safeDownloadName = String(downloadName || '').replace(/[\\/:*?"<>|]/g, '_').slice(0, 180);
    const cacheKey = path + (forceDownload ? ':download:' + safeDownloadName : ':inline');
    const cached = forceRefresh ? null : mediaUrlCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() + 60000) return cached.url;
    const options = forceDownload ? { download: safeDownloadName || true } : {};
    const { data, error } = await client.storage.from(STORAGE_BUCKET).createSignedUrl(path, SIGNED_URL_TTL, options);
    if (error) throw error;
    if (!data || !data.signedUrl) throw new Error('Supabase Storage 未返回有效的签名 URL。');
    mediaUrlCache.set(cacheKey, { url: data.signedUrl, expiresAt: Date.now() + SIGNED_URL_TTL * 1000 });
    return data.signedUrl;
  }
  function collectStorageMediaReferences(value, result = new Set()) {
    if (typeof value === 'string') {
      const pattern = /supabase-storage:\/\/knowledge-media\/([0-9a-f-]{36})\/([a-z0-9][a-z0-9._-]{0,159})/ig;
      let match;
      while ((match = pattern.exec(value))) {
        if (!user || match[1].toLowerCase() !== String(user.id).toLowerCase()) continue;
        result.add(match[1].toLowerCase() + '/' + match[2]);
      }
    } else if (Array.isArray(value)) {
      value.forEach(item => collectStorageMediaReferences(item, result));
    } else if (value && typeof value === 'object') {
      Object.keys(value).forEach(key => collectStorageMediaReferences(value[key], result));
    }
    return result;
  }
  function mediaReferenceToOwnedPath(reference) {
    const match = /^supabase-storage:\/\/knowledge-media\/([0-9a-f-]{36})\/([a-z0-9][a-z0-9._-]{0,159})$/i.exec(String(reference || ''));
    if (!match || !user || match[1].toLowerCase() !== String(user.id).toLowerCase()) return null;
    return match[1].toLowerCase() + '/' + match[2];
  }
  async function getStorageCleanupContext() {
    if (!client || !user) throw new Error('请先登录 Supabase 账号，再清理 Storage。');
    if (!client.storage || typeof client.storage.from !== 'function') throw new Error('当前 Supabase SDK 未提供 Storage API。');
    if (status.mode !== 'linked') throw new Error('请先完成云端首次迁移、恢复或冲突处理，并确保同步状态为“云端已连接”。');
    if (dirty) await pushLocalNow();
    if (status.mode !== 'linked' || dirty || pushInFlight) throw new Error('工作区尚未完成同步或存在冲突。为避免误删，请等待云同步完成后重新扫描。');
    const row = await fetchRow();
    if (!row) throw new Error('云端工作区不存在，已停止清理。');
    const localState = currentState();
    if (!localState || typeof localState !== 'object') throw new Error('无法读取当前工作区，已停止清理。');
    const referencedPaths = collectStorageMediaReferences(localState);
    collectStorageMediaReferences(row.state, referencedPaths);
    // Attachments retained by the 10-second Undo snapshots are still live data:
    // a manual cleanup must not remove them before the user can restore the item.
    const appAdapter = app();
    if (appAdapter && typeof appAdapter.getPendingUndoMediaReferences === 'function') {
      const pendingUndoReferences = appAdapter.getPendingUndoMediaReferences();
      if (Array.isArray(pendingUndoReferences)) {
        pendingUndoReferences.forEach(reference => {
          const path = mediaReferenceToOwnedPath(reference);
          if (path) referencedPaths.add(path);
        });
      }
    }
    // A file can be uploaded while its rich-text form is still open and not yet
    // persisted to the workspace. Treat editor DOM references as live as well.
    if (appAdapter && typeof appAdapter.getActiveEditorStorageMediaReferences === 'function') {
      const activeEditorReferences = appAdapter.getActiveEditorStorageMediaReferences();
      if (Array.isArray(activeEditorReferences)) {
        activeEditorReferences.forEach(reference => {
          const path = mediaReferenceToOwnedPath(reference);
          if (path) referencedPaths.add(path);
        });
      }
    }
    return { row, referencedPaths };
  }
  async function listStorageObjectsRecursive(folderPath, output = [], depth = 0) {
    if (depth > 8) throw new Error('Storage 文件夹嵌套层级异常，已停止扫描。');
    const limit = 100;
    let offset = 0;
    while (true) {
      const { data, error } = await client.storage.from(STORAGE_BUCKET).list(folderPath, {
        limit,
        offset,
        sortBy: { column: 'name', order: 'asc' }
      });
      if (error) throw error;
      const entries = Array.isArray(data) ? data : [];
      for (const entry of entries) {
        if (!entry || typeof entry.name !== 'string' || !entry.name || entry.name === '.' || entry.name === '..') continue;
        const fullPath = folderPath + '/' + entry.name;
        if (!fullPath.startsWith(String(user.id).toLowerCase() + '/')) continue;
        if (entry.id === null) {
          await listStorageObjectsRecursive(fullPath, output, depth + 1);
        } else {
          output.push({ path: fullPath, size: Math.max(0, Number(entry.metadata && entry.metadata.size) || 0) });
        }
      }
      if (entries.length < limit) break;
      offset += entries.length;
      if (offset > 200000) throw new Error('当前账号 Storage 对象数量过大，已停止扫描；请分批处理。');
    }
    return output;
  }
  async function removeOwnedStoragePaths(paths) {
    const prefix = String(user && user.id || '').toLowerCase() + '/';
    const unique = Array.from(new Set((paths || []).filter(path => typeof path === 'string' && path.startsWith(prefix) && !path.includes('..'))));
    let removed = 0;
    for (let index = 0; index < unique.length; index += 1000) {
      const batch = unique.slice(index, index + 1000);
      if (!batch.length) continue;
      const { data, error } = await client.storage.from(STORAGE_BUCKET).remove(batch);
      if (error) throw error;
      removed += Array.isArray(data) ? data.length : batch.length;
      batch.forEach(path => {
        for (const key of mediaUrlCache.keys()) if (key.startsWith(path + ':')) mediaUrlCache.delete(key);
      });
    }
    return removed;
  }
  async function scanStorageCleanup() {
    const { referencedPaths } = await getStorageCleanupContext();
    const objects = await listStorageObjectsRecursive(String(user.id).toLowerCase());
    const orphaned = objects.filter(object => !referencedPaths.has(object.path));
    return {
      userId: user.id,
      totalObjects: objects.length,
      totalBytes: objects.reduce((sum, object) => sum + object.size, 0),
      referencedObjects: objects.length - orphaned.length,
      referencedBytes: objects.filter(object => referencedPaths.has(object.path)).reduce((sum, object) => sum + object.size, 0),
      orphanObjects: orphaned.length,
      orphanBytes: orphaned.reduce((sum, object) => sum + object.size, 0),
      orphanPaths: orphaned.map(object => object.path),
      scannedAt: new Date().toISOString()
    };
  }
  async function cleanupOrphanedStorage() {
    const report = await scanStorageCleanup();
    let deletedObjects = 0;
    let deletedBytes = 0;
    const objects = await listStorageObjectsRecursive(String(user.id).toLowerCase());
    const details = new Map(objects.map(object => [object.path, object.size]));
    // Recheck references before every delete batch so a newly synced attachment
    // is not removed merely because it was orphaned in an earlier scan.
    for (let index = 0; index < report.orphanPaths.length; index += 1000) {
      const batch = report.orphanPaths.slice(index, index + 1000);
      const { referencedPaths } = await getStorageCleanupContext();
      const safeBatch = batch.filter(path => !referencedPaths.has(path));
      if (!safeBatch.length) continue;
      const removed = await removeOwnedStoragePaths(safeBatch);
      deletedObjects += removed;
      deletedBytes += safeBatch.reduce((sum, path) => sum + (details.get(path) || 0), 0);
    }
    const remaining = await scanStorageCleanup();
    return { ...remaining, deletedObjects, deletedBytes };
  }
  async function cleanupRemovedMedia(references) {
    if (!Array.isArray(references) || !references.length) return { deletedObjects: 0 };
    const candidates = Array.from(new Set(references.map(mediaReferenceToOwnedPath).filter(Boolean)));
    if (!candidates.length) return { deletedObjects: 0 };
    const { referencedPaths } = await getStorageCleanupContext();
    const safePaths = candidates.filter(path => !referencedPaths.has(path));
    const deletedObjects = await removeOwnedStoragePaths(safePaths);
    return { deletedObjects, skippedReferenced: candidates.length - safePaths.length };
  }

  function containsInlineMedia(value) {
    if (typeof value === 'string') return /(?:src|href)\s*=\s*["']data:[^"']+["']/i.test(value);
    if (Array.isArray(value)) return value.some(containsInlineMedia);
    if (value && typeof value === 'object') return Object.keys(value).some(key => containsInlineMedia(value[key]));
    return false;
  }
  async function migrateInlineMediaString(value, cache) {
    const pattern = /((?:src|href)\s*=\s*)(["'])(data:[^"']+)\2/gi;
    const matches = Array.from(value.matchAll(pattern));
    if (!matches.length) return { value, changed: false };
    let output = value;
    for (const match of matches) {
      const dataUrl = match[3];
      let reference = cache.get(dataUrl);
      if (!reference) {
        const parts = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/i.exec(dataUrl);
        if (!parts) throw new Error('发现无法识别的旧版 Base64 附件；为防止数据丢失，已停止本次云端写入。');
        const response = await fetch(dataUrl);
        if (!response.ok) throw new Error('读取旧版 Base64 附件失败，未修改云端工作区。');
        const blob = await response.blob();
        let legacyMime = parts[1].toLowerCase();
        if (['application/x-zip-compressed', 'application/x-zip', 'multipart/x-zip'].includes(legacyMime)) legacyMime = 'application/zip';
        reference = await uploadBlobToStorage(blob, legacyMime, 'legacy.' + extensionForMime(legacyMime));
        cache.set(dataUrl, reference);
      }
      output = output.replace(match[0], match[1] + match[2] + reference + match[2]);
    }
    return { value: output, changed: true };
  }
  async function migrateStateInlineMedia(state) {
    const cache = new Map();
    let changed = false;
    async function visit(value) {
      if (typeof value === 'string') {
        const result = await migrateInlineMediaString(value, cache);
        changed = changed || result.changed;
        return result.value;
      }
      if (Array.isArray(value)) {
        const result = [];
        for (const item of value) result.push(await visit(item));
        return result;
      }
      if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = await visit(item);
        return result;
      }
      return value;
    }
    return { state: await visit(state), changed };
  }
  async function prepareStateForStorage(snapshot) {
    const originalFingerprint = fingerprint(snapshot);
    const result = await migrateStateInlineMedia(snapshot);
    if (result.changed) {
      // Persist the smaller state locally only when the live workspace has not
      // changed while the binary uploads were in flight.
      try {
        if (fingerprint(getAppStateOrThrow()) === originalFingerprint) {
          const a = app();
          if (a && typeof a.applyRemoteState === 'function') a.applyRemoteState(result.state);
        }
      } catch (error) {
        console.warn('[EmbeddedSync] Storage migration completed, but local reference update was deferred.', error);
      }
    }
    return result.state;
  }
  async function migrateCloudRowMedia(rawRow) {
    const row = normaliseCloudRow(rawRow);
    if (!row || !containsInlineMedia(row.state)) return row;
    const key = String(user && user.id || '') + ':' + row.revision;
    if (mediaMigrationInFlight.has(key)) return mediaMigrationInFlight.get(key);
    const task = (async () => {
      const result = await migrateStateInlineMedia(row.state);
      if (!result.changed) return row;
      const { data, error } = await client.from(TABLE)
        .update({ state: result.state, revision: row.revision + 1, updated_at: new Date().toISOString() })
        .eq('user_id', user.id).eq('revision', row.revision)
        .select('user_id,state,revision,updated_at').maybeSingle();
      if (error) throw error;
      if (data) return normaliseCloudRow(data);
      const latest = await fetchRow();
      if (latest && !containsInlineMedia(latest.state)) return latest;
      throw new Error('云端附件迁移期间检测到并发修改；原始数据库内容未被覆盖，请重新同步。');
    })();
    mediaMigrationInFlight.set(key, task);
    try { return await task; }
    finally { mediaMigrationInFlight.delete(key); }
  }
  async function fetchRow() {
    if (!client || !user) throw new Error('尚未登录。');
    const { data, error } = await client.from(TABLE).select('user_id,state,revision,updated_at').eq('user_id', user.id).maybeSingle();
    if (error) throw error;
    return normaliseCloudRow(data);
  }
  function setLinked(row, snapshot) {
    // The uploaded snapshot may be older than the live state if the user edits while
    // a network request is in flight. Persist the acknowledged fingerprint, but do
    // not clear the newer local change; schedule a follow-up upload instead.
    const acknowledged = snapshot || getAppStateOrThrow();
    const acknowledgedFp = fingerprint(acknowledged);
    const liveFp = fingerprint(getAppStateOrThrow());
    const hasNewerLocalChanges = liveFp !== acknowledgedFp;
    status.revision = row.revision;
    status.updatedAt = row.updated_at;
    status.hasLocalChanges = hasNewerLocalChanges;
    status.error = '';
    dirty = hasNewerLocalChanges;
    conflictRow = null;
    lastSnapshotFingerprint = acknowledgedFp;
    writeMeta({ userId: user.id, revision: row.revision, fingerprint: acknowledgedFp, updatedAt: row.updated_at || new Date().toISOString() });
    setStatus('linked', hasNewerLocalChanges ? '云端已保存上一笔修改，正在继续同步最新变更…' : '已连接云端，修改将自动同步。');
    ensureRealtimeAndPolling();
    if (hasNewerLocalChanges) schedulePush(150);
  }
  function applyRemote(row, message) {
    const a = app();
    if (!a || typeof a.applyRemoteState !== 'function') throw new Error('页面适配器未准备好。');
    const noticeKey = user.id + ':' + row.revision + ':' + fingerprint(row.state);
    applyingRemote = true;
    try {
      a.applyRemoteState(row.state);
    } finally {
      applyingRemote = false;
    }
    // The application may normalise/migrate the incoming workspace before saving it.
    // Treat that normalised local snapshot as the acknowledged remote state so that
    // applying a remote update never immediately echoes the same data back to cloud.
    const appliedSnapshot = getAppStateOrThrow();
    setLinked(row, appliedSnapshot);
    if (message && lastRemoteNoticeKey !== noticeKey) {
      lastRemoteNoticeKey = noticeKey;
      toast(message);
    }
  }
  function showConflict(row, message) {
    conflictRow = row;
    status.revision = row.revision;
    status.updatedAt = row.updated_at;
    status.hasLocalChanges = true;
    dirty = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = null;
    setStatus('conflict', message || '另一台设备已更新云端数据。自动上传已暂停，请选择保留哪个版本。');
    toast('检测到同步冲突：请打开「偏好与数据 → 云端同步」选择保留云端或本机版本。');
  }
  async function handleRemoteRow(rawRow) {
    if (!user || status.mode === 'needs-upload' || status.mode === 'needs-restore' || status.mode === 'conflict') return;
    let row = normaliseCloudRow(rawRow);
    if (!row || row.revision <= status.revision) return;
    row = await migrateCloudRowMedia(row);
    if (!row || row.revision <= status.revision) return;
    const meta = readMeta();
    const local = getAppStateOrThrow();
    const localFp = fingerprint(local);
    // Realtime can report our own write before the update promise resolves. Match
    // against the exact in-flight snapshot, not only the current live state: the
    // user may already have made a newer edit while that request was pending.
    const rowFp = fingerprint(row.state);
    const upload = inFlightUpload;
    if (upload && row.revision === upload.expectedRevision + 1 && rowFp === upload.fingerprint) {
      status.revision = row.revision;
      status.updatedAt = row.updated_at;
      lastSnapshotFingerprint = upload.fingerprint;
      writeMeta({ userId: user.id, revision: row.revision, fingerprint: upload.fingerprint, updatedAt: row.updated_at || new Date().toISOString() });
      const hasNewerLocalChanges = localFp !== upload.fingerprint;
      status.hasLocalChanges = hasNewerLocalChanges;
      dirty = hasNewerLocalChanges;
      conflictRow = null;
      setStatus('linked', hasNewerLocalChanges ? '云端已确认上一笔修改，正在继续同步最新变更…' : '本机变更已在云端确认。');
      ensureRealtimeAndPolling();
      if (hasNewerLocalChanges) schedulePush(150);
      return;
    }
    // A revision can advance without changing the workspace payload (for example,
    // duplicate/normalising writes from another client). Acknowledge any such row
    // regardless of the revision gap, but do not re-apply it or show a toast.
    if (rowFp === localFp) {
      status.revision = row.revision;
      status.updatedAt = row.updated_at;
      status.hasLocalChanges = false;
      status.error = '';
      dirty = false;
      conflictRow = null;
      lastSnapshotFingerprint = localFp;
      writeMeta({ userId: user.id, revision: row.revision, fingerprint: localFp, updatedAt: row.updated_at || new Date().toISOString() });
      setStatus('linked', '本机数据已与云端保持一致。');
      ensureRealtimeAndPolling();
      return;
    }
    const localMatchesSynced = meta.userId === user.id && localFp === meta.fingerprint && !dirty;
    if (localMatchesSynced) {
      applyRemote(row, '已自动接收其他设备的更新。');
    } else {
      showConflict(row);
    }
  }
  function ensureRealtimeAndPolling() {
    if (!client || !user || status.mode !== 'linked') return;
    // Keep one subscription per signed-in user. Recreating the channel on every
    // acknowledgement can cause reconnect churn and duplicate change deliveries.
    if (!realtimeChannel || realtimeUserId !== user.id) {
      closeRealtime();
      try {
        realtimeChannel = client.channel('workspace-sync-' + user.id)
          .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'user_id=eq.' + user.id }, payload => {
            if (payload && payload.new) handleRemoteRow(payload.new).catch(err => setStatus('error', '接收云端更新失败。', err));
          }).subscribe();
        realtimeUserId = user.id;
      } catch (err) {
        realtimeChannel = null;
        realtimeUserId = '';
        console.warn('[EmbeddedSync] Realtime unavailable; polling remains enabled.', err);
      }
    }
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      if (!client || !user || status.mode !== 'linked') return;
      try {
        const { data, error } = await client.from(TABLE).select('revision,updated_at').eq('user_id', user.id).maybeSingle();
        if (error) throw error;
        if (data && Number(data.revision) > status.revision) {
          const full = await fetchRow();
          if (full) await handleRemoteRow(full);
        }
      } catch (err) {
        status.error = String(err.message || err);
        // Network failures do not block local work. Keep the last known linked state and retry next poll.
        emit();
      }
    }, 20000);
  }
  async function bootstrapUser(nextUser) {
    if (!nextUser || !nextUser.id) return;
    if (bootPromise && bootUserId === nextUser.id) return bootPromise;
    if (user && user.id !== nextUser.id) mediaUrlCache.clear();
    bootUserId = nextUser.id;
    bootPromise = (async () => {
      user = nextUser;
      status.revision = 0;
      status.updatedAt = null;
      status.error = '';
      status.hasLocalChanges = false;
      dirty = false;
      conflictRow = null;
      clearTimers();
      closeRealtime();
      setStatus('loading', '正在检查云端工作区…');
      let row = await fetchRow();
      if (row) row = await migrateCloudRowMedia(row);
      if (passwordRecoveryMode) {
        setStatus('password-recovery', '重置链接已验证，请设置新密码。');
        return;
      }
      const meta = readMeta();
      const local = getAppStateOrThrow();
      const localFp = fingerprint(local);
      if (!row) {
        status.revision = 0;
        setStatus('needs-upload', '这是该账号的空云端工作区。确认后可将此设备现有数据首次迁移到云端。');
        return;
      }
      if (meta.userId !== user.id) {
        conflictRow = row;
        status.revision = row.revision;
        status.updatedAt = row.updated_at;
        setStatus('needs-restore', '云端已有数据。为避免覆盖，请先从云端恢复，或明确选择用此设备的数据覆盖云端。');
        return;
      }
      const matchesLastSynced = localFp === meta.fingerprint;
      if (row.revision > Number(meta.revision || 0)) {
        if (matchesLastSynced) {
          applyRemote(row, '已同步其他设备上的最新数据。');
        } else {
          showConflict(row, '本机与云端在上次同步后都发生了修改。为避免丢失数据，请选择保留哪个版本。');
        }
        return;
      }
      if (row.revision < Number(meta.revision || 0)) {
        showConflict(row, '云端版本号低于本机记录的版本。为避免回滚，请检查后手动选择版本。');
        return;
      }
      status.revision = row.revision;
      status.updatedAt = row.updated_at;
      if (matchesLastSynced) {
        setLinked(row, local);
      } else {
        dirty = true;
        status.hasLocalChanges = true;
        lastSnapshotFingerprint = meta.fingerprint || '';
        setStatus('linked', '发现本机有尚未上传的变更，正在安全同步…');
        schedulePush(150);
        ensureRealtimeAndPolling();
      }
    })().catch(err => {
      setStatus('error', '登录成功，但检查云端数据失败；本地数据仍保留。', err);
    }).finally(() => { bootPromise = null; });
    return bootPromise;
  }
  function attachAuthListener() {
    if (!client) return;
    if (authSubscription && authSubscription.unsubscribe) authSubscription.unsubscribe();
    const result = client.auth.onAuthStateChange((event, session) => {
      setTimeout(async () => {
        if (session && session.user) {
          const sameUser = user && user.id === session.user.id;
          user = session.user;
          if (event === 'PASSWORD_RECOVERY') {
            passwordRecoveryMode = true;
            clearTimers();
            closeRealtime();
            status.user = { id: user.id, email: user.email || '' };
            setStatus('password-recovery', '重置链接已验证，请设置新密码。');
            return;
          }
          if (!sameUser || event === 'INITIAL_SESSION' || event === 'SIGNED_IN') {
            await bootstrapUser(session.user);
          } else {
            status.user = { id: user.id, email: user.email || '' };
            emit();
          }
        } else if (event === 'SIGNED_OUT' || event === 'INITIAL_SESSION' || !session) {
          user = null;
          mediaUrlCache.clear();
          passwordRecoveryMode = false;
          bootUserId = '';
          bootPromise = null;
          clearTimers();
          closeRealtime();
          dirty = false;
          conflictRow = null;
          status.user = null;
          status.revision = 0;
          setStatus(status.configured ? 'signed-out' : 'unconfigured', status.configured ? '已保留本机数据。登录后即可继续同步。' : '先配置 Supabase 项目连接信息。');
        }
      }, 0);
    });
    authSubscription = result.data && result.data.subscription;
  }
  function buildClient(config) {
    if (!SDK || typeof SDK.createClient !== 'function') { setStatus('error', 'Supabase JS SDK 未能加载。请检查网络后刷新页面。'); throw new Error('Supabase JS SDK 未能加载。请检查网络后刷新页面。'); }
    stopClientListeners();
    client = SDK.createClient(config.url, config.publishableKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
    });
    user = null;
    passwordRecoveryMode = false;
    status.configured = true;
    status.error = '';
    attachAuthListener();
  }
  async function configure(url, publishableKey) {
    url = String(url || '').trim().replace(/\/+$/, '');
    publishableKey = String(publishableKey || '').trim();
    if (!url || !publishableKey) throw new Error('请填写 Supabase Project URL 和 publishable/anon 公共密钥。');
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error('Project URL 格式不正确。'); }
    if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol !== 'https:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) {
      throw new Error('正式站点请使用 HTTPS 格式的 Supabase Project URL。');
    }
    let legacyRole = '';
    if (publishableKey.split('.').length === 3 && typeof window.atob === 'function') {
      try {
        const payload = publishableKey.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
        const padded = payload + '='.repeat((4 - payload.length % 4) % 4);
        const claims = JSON.parse(window.atob(padded));
        legacyRole = String(claims.role || '');
      } catch (_) {}
    }
    if (/service_role|sb_secret_/i.test(publishableKey) || legacyRole === 'service_role') throw new Error('此处不能使用 service_role 或 secret 密钥，请使用 publishable key 或旧版 anon key。');
    localSet(CONFIG_KEY, JSON.stringify({ url, publishableKey }));
    buildClient({ url, publishableKey });
    setStatus('loading', '连接配置已保存，正在检查登录状态…');
    const { data, error } = await client.auth.getSession();
    if (error) throw error;
    if (data.session && data.session.user) await bootstrapUser(data.session.user);
    else setStatus('signed-out', '连接配置已保存。请登录或创建账号。');
    return true;
  }
  async function signIn(email, password, intent) {
    if (!client) throw new Error('请先保存 Supabase 连接配置。');
    email = String(email || '').trim(); password = String(password || '');
    if (!email || !password) throw new Error('请填写邮箱和密码。');
    if (intent === 'signup') {
      if (password.length < 8) throw new Error('为提高安全性，密码至少需要 8 个字符。');
      const { data, error } = await client.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin + window.location.pathname } });
      if (error) throw error;
      if (data.session && data.user) await bootstrapUser(data.user);
      else setStatus('signed-out', '注册请求已提交。如项目启用了邮箱验证，请先打开验证邮件，再返回网站登录。');
      return data;
    }
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) throw error;
    if (data.user) await bootstrapUser(data.user);
    return data;
  }
  async function signOut() {
    if (!client) return;
    if (status.mode === 'conflict') throw new Error('存在尚未解决的同步冲突。请先处理冲突或导出本机备份，再退出登录。');
    if (dirty && status.mode === 'linked') {
      await pushLocalNow();
      // If the local state changed during an upload, setLinked schedules another
      // pass. Wait for the pending pass before dropping the authenticated session.
      for (let attempt = 0; attempt < 4 && dirty && status.mode === 'linked'; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 200));
        if (dirty && !pushInFlight) await pushLocalNow();
      }
      if (dirty) throw new Error('还有修改尚未同步。请保持联网，等待同步完成后再退出。');
    }
    const { error } = await client.auth.signOut();
    if (error) throw error;
    toast('已退出云同步账号；本机缓存没有被删除。');
  }
  async function resetPassword(email) {
    if (!client) throw new Error('请先保存 Supabase 连接配置。');
    email = String(email || '').trim();
    if (!email) throw new Error('请先在邮箱字段填写要重置密码的地址。');
    const { error } = await client.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin + window.location.pathname });
    if (error) throw error;
    toast('密码重置邮件已发送（若该地址允许接收邮件）。');
  }
  async function updatePassword(password) {
    if (!client || !user) throw new Error('密码重置会话已失效，请重新打开邮件中的链接。');
    password = String(password || '');
    if (password.length < 8) throw new Error('新密码至少需要 8 个字符。');
    const { data, error } = await client.auth.updateUser({ password });
    if (error) throw error;
    passwordRecoveryMode = false;
    bootPromise = null;
    bootUserId = '';
    await bootstrapUser(data && data.user ? data.user : user);
    toast('密码已更新。');
    return data;
  }
  async function uploadLocal() {
    if (!user || status.mode !== 'needs-upload') throw new Error('当前账号的云端工作区不是空白，不能走首次迁移流程。');
    const snapshot = await prepareStateForStorage(getAppStateOrThrow());
    setStatus('syncing', '正在将当前设备数据首次迁移到云端…');
    const now = new Date().toISOString();
    const { data, error } = await client.from(TABLE).insert({ user_id: user.id, state: snapshot, revision: 1, updated_at: now }).select('user_id,state,revision,updated_at').single();
    if (error) {
      if (error.code === '23505') {
        const row = await fetchRow();
        conflictRow = row;
        setStatus('needs-restore', '迁移时发现云端已出现数据。请先恢复云端版本，或明确选择覆盖。');
        return;
      }
      throw error;
    }
    const row = normaliseCloudRow(data);
    setLinked(row, snapshot);
    toast('本机学习数据已迁移到云端。');
  }
  async function restoreCloud() {
    if (!user) throw new Error('请先登录。');
    let row = await fetchRow();
    if (!row) { setStatus('needs-upload', '云端没有数据，可以将此设备数据迁移到云端。'); return; }
    row = await migrateCloudRowMedia(row);
    if (!window.confirm('从云端恢复会覆盖此浏览器当前的学习数据。建议先导出本机 JSON 备份。确定继续吗？')) return;
    applyRemote(row, '已从云端恢复学习数据。');
  }
  async function overwriteCloudWithLocal(expectedRow) {
    if (!user) throw new Error('请先登录。');
    const row = expectedRow || conflictRow || await fetchRow();
    if (!row) return uploadLocal();
    const snapshot = await prepareStateForStorage(getAppStateOrThrow());
    setStatus('syncing', '正在以本机数据更新云端版本…');
    const { data, error } = await client.from(TABLE)
      .update({ state: snapshot, revision: row.revision + 1, updated_at: new Date().toISOString() })
      .eq('user_id', user.id).eq('revision', row.revision)
      .select('user_id,state,revision,updated_at').maybeSingle();
    if (error) throw error;
    if (!data) {
      const newer = await fetchRow();
      showConflict(newer, '覆盖操作期间云端又发生了变化。没有覆盖任何数据，请重新检查冲突。');
      return;
    }
    setLinked(normaliseCloudRow(data), snapshot);
    toast('云端已更新为此设备的数据。');
  }
  async function forceUploadLocal() {
    if (!user) throw new Error('请先登录。');
    if (!window.confirm('这会用当前设备的数据覆盖云端工作区，其他设备的数据可能丢失。请确认已导出备份并确实要覆盖。')) return;
    await overwriteCloudWithLocal(conflictRow || await fetchRow());
  }
  async function resolveConflict(choice) {
    if (!conflictRow) throw new Error('当前没有待处理的同步冲突。');
    const row = conflictRow;
    if (choice === 'remote') {
      if (!window.confirm('将采用云端版本并覆盖本机当前数据。建议先导出本机 JSON 备份。确定继续吗？')) return;
      applyRemote(row, '已采用云端版本；本机数据已更新。');
    } else if (choice === 'local') {
      if (!window.confirm('将用本机版本覆盖云端。其他设备尚未同步的更改可能丢失。确定继续吗？')) return;
      await overwriteCloudWithLocal(row);
    } else throw new Error('未知的冲突处理方式。');
  }
  function schedulePush(delay) {
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(() => pushLocalNow().catch(err => {
      status.hasLocalChanges = true;
      setStatus('linked', '本机数据已保存，但暂时无法上传；联网后会重试。', err);
      if (status.mode !== 'conflict') {
        pushTimer = setTimeout(() => pushLocalNow().catch(retryErr => {
          status.error = String(retryErr.message || retryErr); emit();
          if (status.mode === 'linked') pushTimer = setTimeout(() => pushLocalNow().catch(() => {}), 12000);
        }), 12000);
      }
    }), delay == null ? 850 : delay);
  }
  async function pushLocalNow() {
    if (!client || !user || status.mode !== 'linked' || !dirty) return;
    if (pushInFlight) { pendingPush = true; return; }
    pushInFlight = true;
    pendingPush = false;
    let uploadFailed = false;
    try {
      const snapshot = await prepareStateForStorage(getAppStateOrThrow());
      const fp = fingerprint(snapshot);
      const expectedRevision = status.revision;
      inFlightUpload = { expectedRevision, fingerprint: fp };
      if (fp === lastSnapshotFingerprint) {
        dirty = false;
        status.hasLocalChanges = false;
        emit();
        return;
      }
      const { data, error } = await client.from(TABLE)
        .update({ state: snapshot, revision: expectedRevision + 1, updated_at: new Date().toISOString() })
        .eq('user_id', user.id).eq('revision', expectedRevision)
        .select('user_id,state,revision,updated_at').maybeSingle();
      if (error) throw error;
      if (!data) {
        const row = await fetchRow();
        showConflict(row, '上传时发现云端已被其他设备修改。为避免覆盖，自动上传已暂停。');
        return;
      }
      setLinked(normaliseCloudRow(data), snapshot);
    } catch (error) {
      uploadFailed = true;
      throw error;
    } finally {
      inFlightUpload = null;
      pushInFlight = false;
      const shouldPushAgain = (pendingPush || (!uploadFailed && dirty)) && status.mode === 'linked';
      pendingPush = false;
      if (shouldPushAgain) schedulePush(150);
    }
  }
  async function getProjectUsage() {
    if (!client || !user) throw new Error('请先登录 Supabase 账号，再查看项目容量。');
    if (!client.functions || typeof client.functions.invoke !== 'function') {
      throw new Error('当前 Supabase SDK 不支持 Edge Functions 调用，请刷新页面或更新 SDK。');
    }
    const { data, error } = await client.functions.invoke('usage-monitor', { body: {} });
    if (error) {
      let message = error.message || '容量查询失败。';
      try {
        if (error.context && typeof error.context.json === 'function') {
          const detail = await error.context.json();
          if (detail && (detail.error || detail.message)) message = detail.error || detail.message;
        }
      } catch (_) {}
      throw new Error(message);
    }
    if (!data || typeof data !== 'object' || !Number.isFinite(Number(data.database_bytes)) || !Number.isFinite(Number(data.storage_bytes))) {
      throw new Error('容量监控函数返回的数据格式不正确。请检查 Edge Function 与 SQL 函数是否已部署。');
    }
    return data;
  }

  async function syncNow() {
    if (!user) throw new Error('请先登录。');
    if (status.mode === 'conflict') throw new Error('请先处理同步冲突。');
    if (status.mode === 'needs-upload') return uploadLocal();
    if (status.mode === 'needs-restore') return restoreCloud();
    if (dirty) return pushLocalNow();
    const row = await fetchRow();
    if (!row) { setStatus('needs-upload', '云端数据不存在，可以迁移本机数据。'); return; }
    await handleRemoteRow(row);
    if (status.mode === 'linked') toast('云端检查完成，当前已是最新版本。');
  }
  function onLocalSave() {
    // Remote state application can trigger app-level persistence hooks in future
    // builds. Never classify that write as a new local edit or echo it to cloud.
    if (applyingRemote) return;
    if (!user) return;
    if (status.mode !== 'linked') return;
    dirty = true;
    status.hasLocalChanges = true;
    setStatus('linked', '本机已保存，正在等待自动上传…');
    schedulePush();
  }
  async function initialiseFromConfig() {
    const cfg = readConfig();
    if (!cfg.url || !cfg.publishableKey) {
      status.configured = false;
      setStatus('unconfigured', '请填写 Supabase Project URL 和 publishable/anon key。');
      return;
    }
    if (!SDK || typeof SDK.createClient !== 'function') {
      setStatus('error', 'Supabase SDK 未加载。网站的本地功能仍可用，请检查网络或 CDN 访问。');
      return;
    }
    try {
      buildClient(cfg);
      const { data, error } = await client.auth.getSession();
      if (error) throw error;
      if (data.session && data.session.user) await bootstrapUser(data.session.user);
      else setStatus('signed-out', '连接配置已读取，请登录或创建账号。');
    } catch (err) {
      setStatus('error', 'Supabase 连接初始化失败。', err);
    }
  }

  window.EmbeddedSync = {
    getStatus: () => ({ ...status, user: status.user ? { ...status.user } : null, conflict: !!conflictRow }),
    getConfig: readConfig,
    configure,
    signIn,
    signOut,
    resetPassword,
    updatePassword,
    uploadLocal,
    restoreCloud,
    forceUploadLocal,
    resolveConflict,
    syncNow,
    getProjectUsage,
    uploadMediaFile,
    resolveMediaUrl,
    scanStorageCleanup,
    cleanupOrphanedStorage,
    cleanupRemovedMedia,
    onLocalSave,
    reinitialise: initialiseFromConfig
  };

  // If config is supplied in sync-config.js, it is picked up automatically on page load.
  initialiseFromConfig();
})();
