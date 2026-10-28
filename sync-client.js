/* Supabase Auth + versioned workspace sync for the standalone GitHub Pages app. */
(function () {
  'use strict';

  const TABLE = 'embedded_learning_workspaces';
  const CONFIG_KEY = 'embedded-learning-hub-supabase-config-v1';
  const META_KEY = 'embedded-learning-hub-sync-meta-v1';
  const SDK = window.supabase;

  let client = null;
  let user = null;
  let authSubscription = null;
  let realtimeChannel = null;
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
  function fingerprint(value) {
    const input = JSON.stringify(value);
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
    a.applyRemoteState(row.state);
    setLinked(row, getAppStateOrThrow());
    if (message) toast(message);
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
    const row = normaliseCloudRow(rawRow);
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
    // A next-revision event that exactly equals the live local state is also safe
    // to accept (for example an identical write from another tab).
    if (row.revision === status.revision + 1 && rowFp === localFp) {
      status.revision = row.revision;
      status.updatedAt = row.updated_at;
      status.hasLocalChanges = false;
      dirty = false;
      lastSnapshotFingerprint = localFp;
      writeMeta({ userId: user.id, revision: row.revision, fingerprint: localFp, updatedAt: row.updated_at || new Date().toISOString() });
      setStatus('linked', '本机变更已在云端确认。');
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
    closeRealtime();
    try {
      realtimeChannel = client.channel('workspace-sync-' + user.id)
        .on('postgres_changes', { event: '*', schema: 'public', table: TABLE, filter: 'user_id=eq.' + user.id }, payload => {
          if (payload && payload.new) handleRemoteRow(payload.new).catch(err => setStatus('error', '接收云端更新失败。', err));
        }).subscribe();
    } catch (err) { console.warn('[EmbeddedSync] Realtime unavailable; polling remains enabled.', err); }
    if (pollTimer) clearInterval(pollTimer);
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
      const row = await fetchRow();
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
    const snapshot = getAppStateOrThrow();
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
    const row = await fetchRow();
    if (!row) { setStatus('needs-upload', '云端没有数据，可以将此设备数据迁移到云端。'); return; }
    if (!window.confirm('从云端恢复会覆盖此浏览器当前的学习数据。建议先导出本机 JSON 备份。确定继续吗？')) return;
    applyRemote(row, '已从云端恢复学习数据。');
  }
  async function overwriteCloudWithLocal(expectedRow) {
    if (!user) throw new Error('请先登录。');
    const row = expectedRow || conflictRow || await fetchRow();
    if (!row) return uploadLocal();
    const snapshot = getAppStateOrThrow();
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
    const snapshot = getAppStateOrThrow();
    const fp = fingerprint(snapshot);
    const expectedRevision = status.revision;
    inFlightUpload = { expectedRevision, fingerprint: fp };
    try {
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
    } finally {
      inFlightUpload = null;
      pushInFlight = false;
      const shouldPushAgain = (pendingPush || dirty) && status.mode === 'linked';
      pendingPush = false;
      if (shouldPushAgain) schedulePush(150);
    }
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
    onLocalSave,
    reinitialise: initialiseFromConfig
  };

  // If config is supplied in sync-config.js, it is picked up automatically on page load.
  initialiseFromConfig();
})();
