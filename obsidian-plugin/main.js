const { Plugin, PluginSettingTab, Setting, Notice, requestUrl, TFile } = require('obsidian');

const DEFAULT_SETTINGS = {
  supabaseUrl: '',
  publishableKey: '',
  email: '',
  accessToken: '',
  refreshToken: '',
  expiresAt: 0,
  userId: '',
  deviceId: '',
  syncIntervalSeconds: 25,
  docs: {},
  pendingDeletes: {}
};

const TABLE = 'embedded_learning_obsidian_documents';
const ROOT = '嵌入式学习站';
const ROOT_PATH = ROOT + '/';
const CONFLICTS_PATH = ROOT + '/同步冲突';
const ALLOWED_CATEGORIES = new Set(['knowledge', 'record', 'resource', 'course', 'lesson']);

function normalizeMarkdown(markdown) {
  return String(markdown || '').replace(/\r\n?/g, '\n').replace(/^(---\n[\s\S]*?\n---\s*\n?)/, (frontmatter) =>
    frontmatter.replace(/^els_revision:\s*.*\n?/m, '').replace(/^els_hash:\s*.*\n?/m, '')
  ).trimEnd();
}

function hashDocument(doc) {
  const value = JSON.stringify([
    String(doc.category || ''), String(doc.path || ''), String(doc.title || ''), normalizeMarkdown(doc.markdown)
  ]);
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0') + ':' + value.length;
}

function parseFrontmatter(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '');
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { meta: {}, body: text };
  const lines = match[1].split('\n');
  const meta = {};
  const scalar = raw => {
    const value = String(raw || '').trim();
    try { return JSON.parse(value); } catch (_) { return value.replace(/^['"]|['"]$/g, ''); }
  };
  for (let i = 0; i < lines.length; i++) {
    const found = lines[i].match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!found) continue;
    const key = found[1];
    const raw = found[2].trim();
    if (raw) { meta[key] = scalar(raw); continue; }
    const items = [];
    let j = i + 1;
    while (j < lines.length && /^\s+-\s+/.test(lines[j])) {
      items.push(scalar(lines[j].replace(/^\s+-\s+/, '')));
      j++;
    }
    if (items.length) { meta[key] = items; i = j - 1; }
    else meta[key] = '';
  }
  return { meta, body: text.slice(match[0].length) };
}
function serializeFrontmatter(meta, body) {
  const lines = Object.entries(meta)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `---\n${lines.join('\n')}\n---\n\n${String(body || '').replace(/^\n+/, '')}`;
}

function updateFrontmatter(markdown, updates) {
  const parsed = parseFrontmatter(markdown);
  return serializeFrontmatter({ ...parsed.meta, ...updates }, parsed.body);
}

function safePath(path) {
  const parts = String(path || '').replace(/\\/g, '/').split('/').filter(part => part && part !== '.' && part !== '..');
  if (parts[0] !== ROOT) return '';
  return parts.join('/');
}

function safeFileSegment(value) {
  return String(value || '未命名').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-').replace(/[. ]+$/g, '').trim().slice(0, 72) || '未命名';
}

function randomId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

function docFromFile(file, markdown, meta) {
  const category = String(meta.els_type || String(meta.els_id || '').split(':')[0] || '');
  const documentId = String(meta.els_id || '');
  return {
    document_id: documentId,
    category,
    path: file.path,
    title: String(meta.title || file.basename || '未命名'),
    markdown,
    content_hash: '',
    revision: Number(meta.els_revision) || 0,
    deleted_at: null
  };
}

class EmbeddedLearningBridge extends Plugin {
  async onload() {
    await this.loadSettings();
    if (!this.settings.deviceId) {
      this.settings.deviceId = randomId('device');
      await this.saveSettings();
    }
    this.syncRunning = false;
    this.statusBar = typeof this.addStatusBarItem === 'function' ? this.addStatusBarItem() : null;
    this.statusBar?.setText?.('Obsidian 待同步');
    this.applyingRemote = false;
    this.syncQueued = false;
    this.syncTimer = null;
    this.pollTimer = null;
    this.knownFiles = new Map();
    this.addSettingTab(new EmbeddedLearningBridgeSettingTab(this.app, this));

    this.addCommand({
      id: 'sync-now',
      name: '立即同步学习站文档',
      callback: () => this.syncNow().catch(error => this.reportError(error))
    });

    this.registerVaultEvents();
    this.registerDomEvent(window, 'online', () => this.scheduleSync(700));
    this.registerDomEvent(window, 'focus', () => this.scheduleSync(700));
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') this.scheduleSync(700);
    });

    this.app.workspace.onLayoutReady(() => {
      this.scheduleSync(1200);
      this.pollTimer = window.setInterval(() => {
        if (document.visibilityState !== 'hidden' && this.settings.refreshToken) this.syncNow().catch(error => this.logError(error));
      }, Math.max(15, Number(this.settings.syncIntervalSeconds) || 25) * 1000);
    });
  }

  onunload() {
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    if (this.pollTimer) window.clearInterval(this.pollTimer);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.docs = this.settings.docs || {};
    this.settings.pendingDeletes = this.settings.pendingDeletes || {};
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  registerVaultEvents() {
    this.registerEvent(this.app.vault.on('modify', file => {
      if (file instanceof TFile && file.extension === 'md' && file.path.startsWith(ROOT_PATH) && !this.applyingRemote) this.scheduleSync(1600);
    }));
    this.registerEvent(this.app.vault.on('create', file => {
      if (file instanceof TFile && file.extension === 'md' && file.path.startsWith(ROOT_PATH) && !this.applyingRemote) this.scheduleSync(1100);
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (this.applyingRemote) return;
      if ((file instanceof TFile && file.path.startsWith(ROOT_PATH)) || String(oldPath || '').startsWith(ROOT_PATH)) this.scheduleSync(1200);
    }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (this.applyingRemote || !(file instanceof TFile) || !file.path.startsWith(ROOT_PATH)) return;
      const known = this.knownFiles.get(file.path);
      if (known && known.document_id) this.settings.pendingDeletes[known.document_id] = known;
      this.saveSettings().catch(error => this.logError(error));
      this.scheduleSync(900);
    }));
  }

  scheduleSync(delay = 1300) {
    if (!this.settings || !this.settings.refreshToken || !this.settings.supabaseUrl || !this.settings.publishableKey) return;
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => this.syncNow().catch(error => this.reportError(error)), delay);
  }

  projectUrl() {
    return String(this.settings.supabaseUrl || '').trim().replace(/\/$/, '');
  }

  ensureConfiguration() {
    if (!this.projectUrl() || !String(this.settings.publishableKey || '').trim()) {
      throw new Error('请先在插件设置中填写 Supabase Project URL 和 Publishable / anon key。');
    }
  }

  async request(url, options = {}) {
    const response = await requestUrl({
      url,
      method: options.method || 'GET',
      headers: options.headers || {},
      body: options.body,
      throw: false
    });
    let body = response.json;
    if (body === undefined && response.text) {
      try { body = JSON.parse(response.text); } catch (_) { body = response.text; }
    }
    if (response.status < 200 || response.status >= 300) {
      const detail = body && (body.msg || body.message || body.error_description || body.error) || `HTTP ${response.status}`;
      throw new Error(String(detail));
    }
    return body;
  }

  async signIn(email, password) {
    this.ensureConfiguration();
    const body = await this.request(`${this.projectUrl()}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: this.settings.publishableKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: String(email || '').trim(), password: String(password || '') })
    });
    if (!body || !body.access_token || !body.refresh_token || !body.user?.id) throw new Error('Supabase 登录响应不完整。');
    this.settings.email = body.user.email || String(email || '').trim();
    this.settings.accessToken = body.access_token;
    this.settings.refreshToken = body.refresh_token;
    this.settings.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    this.settings.userId = body.user.id;
    await this.saveSettings();
    new Notice('已登录 Supabase。正在同步 Obsidian Vault…');
    await this.syncNow();
  }

  async signOut() {
    const token = this.settings.accessToken;
    if (token) {
      try {
        await this.request(`${this.projectUrl()}/auth/v1/logout`, {
          method: 'POST', headers: { apikey: this.settings.publishableKey, Authorization: `Bearer ${token}` }
        });
      } catch (_) { /* Local sign-out must still complete. */ }
    }
    this.settings.accessToken = '';
    this.settings.refreshToken = '';
    this.settings.expiresAt = 0;
    this.settings.userId = '';
    await this.saveSettings();
    new Notice('已从 Obsidian 同步账号退出。');
  }

  async ensureAccessToken() {
    this.ensureConfiguration();
    if (!this.settings.refreshToken) throw new Error('请先在插件设置中使用同一 Supabase 账号登录。');
    if (this.settings.accessToken && Date.now() < Number(this.settings.expiresAt || 0) - 60000) return this.settings.accessToken;
    let body;
    try {
      body = await this.request(`${this.projectUrl()}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: this.settings.publishableKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: this.settings.refreshToken })
      });
    } catch (error) {
      this.settings.accessToken = '';
      this.settings.refreshToken = '';
      this.settings.expiresAt = 0;
      await this.saveSettings();
      throw new Error(`Supabase 会话刷新失败，请重新登录：${error.message || error}`);
    }
    if (!body || !body.access_token || !body.refresh_token) {
      this.settings.accessToken = '';
      this.settings.refreshToken = '';
      this.settings.expiresAt = 0;
      await this.saveSettings();
      throw new Error('Supabase 登录已过期，请重新登录。');
    }
    this.settings.accessToken = body.access_token;
    this.settings.refreshToken = body.refresh_token;
    this.settings.expiresAt = Date.now() + (Number(body.expires_in) || 3600) * 1000;
    this.settings.userId = body.user?.id || this.settings.userId;
    this.settings.email = body.user?.email || this.settings.email;
    await this.saveSettings();
    return this.settings.accessToken;
  }

  async api(path, options = {}) {
    const token = await this.ensureAccessToken();
    const headers = Object.assign({
      apikey: this.settings.publishableKey,
      Authorization: `Bearer ${token}`,
      Accept: 'application/json'
    }, options.headers || {});
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';
    return this.request(`${this.projectUrl()}${path}`, { ...options, headers });
  }

  async fetchRemoteDocs() {
    const rows = [];
    for (let offset = 0; ; offset += 1000) {
      const query = `?select=document_id,category,path,title,markdown,content_hash,revision,deleted_at,updated_at&order=updated_at.asc&limit=1000&offset=${offset}`;
      const page = await this.api(`/rest/v1/${TABLE}${query}`);
      if (Array.isArray(page)) rows.push(...page);
      if (!Array.isArray(page) || page.length < 1000) break;
    }
    return new Map(rows.map(row => [row.document_id, row]));
  }

  async pushBatch(documents) {
    const results = [];
    for (let i = 0; i < documents.length; i += 200) {
      const result = await this.api('/rest/v1/rpc/embedded_learning_sync_documents', {
        method: 'POST', body: JSON.stringify({ p_documents: documents.slice(i, i + 200) })
      });
      if (!Array.isArray(result)) throw new Error('Supabase 文档同步接口返回格式异常。');
      results.push(...result);
    }
    return results;
  }

  async ensureFolder(folder) {
    const parts = folder.split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        try { await this.app.vault.createFolder(current); }
        catch (error) {
          if (!this.app.vault.getAbstractFileByPath(current)) throw error;
        }
      }
    }
  }

  async uniquePath(path, documentId) {
    const normalized = safePath(path);
    if (!normalized) throw new Error('远端文档路径不合法，已阻止写入 Vault。');
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (!existing || !(existing instanceof TFile)) return normalized;
    const raw = await this.app.vault.read(existing);
    const { meta } = parseFrontmatter(raw);
    if (meta.els_id === documentId) return normalized;
    const dot = normalized.lastIndexOf('.md');
    return `${normalized.slice(0, dot)}-${safeFileSegment(documentId.split(':').slice(1).join(':'))}.md`;
  }

  async writeRemoteDocument(row, fileById) {
    const documentId = row.document_id;
    const targetPath = await this.uniquePath(row.path, documentId);
    const content = updateFrontmatter(row.markdown || '', {
      els_id: documentId,
      els_type: row.category,
      els_revision: Number(row.revision) || 1,
      els_hash: row.content_hash || hashDocument(row),
      title: row.title || '未命名'
    });
    const previous = fileById.get(documentId) || null;
    await this.ensureFolder(targetPath.split('/').slice(0, -1).join('/'));
    this.applyingRemote = true;
    try {
      let file = previous;
      if (file && file.path !== targetPath) {
        const target = this.app.vault.getAbstractFileByPath(targetPath);
        if (target && target !== file) throw new Error(`目标路径已被其他文件占用：${targetPath}`);
        await this.app.vault.rename(file, targetPath);
        file = this.app.vault.getAbstractFileByPath(targetPath);
      }
      if (file) await this.app.vault.modify(file, content);
      else {
        const existing = this.app.vault.getAbstractFileByPath(targetPath);
        if (existing instanceof TFile) await this.app.vault.modify(existing, content);
        else await this.app.vault.create(targetPath, content);
      }
      this.knownFiles.set(targetPath, {
        document_id: documentId, category: row.category, path: targetPath,
        title: row.title || '', markdown: content
      });
    } finally { this.applyingRemote = false; }
  }

  async removeRemoteDocument(row, fileById) {
    const file = fileById.get(row.document_id);
    if (!file) return;
    this.applyingRemote = true;
    try {
      if (this.app.fileManager && typeof this.app.fileManager.trashFile === 'function') await this.app.fileManager.trashFile(file);
      else await this.app.vault.delete(file);
      this.knownFiles.delete(file.path);
    } finally { this.applyingRemote = false; }
  }

  courseIdForFolder(folder, courseDocs) {
    const found = courseDocs.find(doc => doc.path.split('/').slice(0, -1).join('/') === folder);
    if (found) return String(found.document_id).slice('course:'.length);
    const leaf = folder.split('/').pop() || '';
    const match = leaf.match(/-(course[_-][A-Za-z0-9_-]+|[A-Za-z0-9]{5,})$/);
    return match ? match[1] : 'imported-course';
  }

  async scanVault() {
    this.knownFiles = new Map();
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(ROOT_PATH) && !file.path.startsWith(`${CONFLICTS_PATH}/`));
    const docs = new Map();
    const courseDocs = [];
    const snapshots = [];
    for (const file of files) {
      const markdown = await this.app.vault.read(file);
      const parsed = parseFrontmatter(markdown);
      let meta = parsed.meta;
      let documentId = String(meta.els_id || '');
      let category = String(meta.els_type || documentId.split(':')[0] || '');
      if (!documentId || !ALLOWED_CATEGORIES.has(category)) {
        const newDoc = this.inferNewDocument(file, parsed, courseDocs);
        meta = newDoc.meta;
        documentId = newDoc.documentId;
        category = newDoc.category;
        const tagged = serializeFrontmatter(meta, parsed.body);
        this.applyingRemote = true;
        try { await this.app.vault.modify(file, tagged); }
        finally { this.applyingRemote = false; }
      } else if (docs.has(documentId)) {
        // A copied Markdown file may carry the original els_id. Give the copy a
        // fresh identity so two Vault files can never silently alias one cloud row.
        const entityId = randomId('obsidian');
        documentId = `${category}:${entityId}`;
        meta = { ...meta, els_id: documentId, els_type: category, els_entity_id: entityId, els_revision: 0, els_hash: '' };
        this.applyingRemote = true;
        try { await this.app.vault.modify(file, serializeFrontmatter(meta, parsed.body)); }
        finally { this.applyingRemote = false; }
      }
      const doc = docFromFile(file, await this.app.vault.read(file), meta);
      doc.category = category;
      doc.content_hash = hashDocument(doc);
      doc.revision = Number(meta.els_revision) || 0;
      docs.set(documentId, doc);
      snapshots.push({ path: file.path, document_id: documentId, category, title: doc.title, markdown: doc.markdown });
      this.knownFiles.set(file.path, { document_id: documentId, category, path: file.path, title: doc.title, markdown: doc.markdown });
      if (category === 'course') courseDocs.push(doc);
    }
    return { docs, files: new Map(files.map(file => [file.path, file])), courseDocs, snapshots };
  }

  inferNewDocument(file, parsed, courseDocs) {
    const parts = file.path.split('/');
    const section = parts[1] || '';
    const basename = file.basename;
    let category = 'knowledge';
    const entityId = randomId('obsidian');
    const title = String(parsed.meta.title || basename.replace(/-\w{5,}$/g, '').replace(/[_-]+/g, ' ').trim() || '未命名');
    const meta = { ...parsed.meta, title, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    if (section === '知识库') {
      category = 'knowledge';
      meta.category = meta.category || 'MY NOTE';
    } else if (section === '学习记录') {
      category = 'record';
      meta.date = meta.date || new Date().toISOString().slice(0, 10);
      meta.minutes = Number(meta.minutes) || 0;
      meta.category = meta.category || '自定义';
    } else if (section === '资源') {
      category = 'resource';
      const link = (parsed.body.match(/https?:\/\/[^\s)]+/) || [])[0] || '';
      meta.url = meta.url || link;
      meta.category = meta.category || '自定义';
      meta.tag = meta.tag || 'OBSIDIAN';
    } else if (section === '课程笔记') {
      const folder = parts.slice(0, -1).join('/');
      category = 'lesson';
      meta.course_id = meta.course_id || this.courseIdForFolder(folder, courseDocs);
      meta.course_title = meta.course_title || folder.split('/').pop().replace(/-[^-]+$/, '');
      meta.stage = meta.stage || '补充与拓展';
      meta.minutes = Number(meta.minutes) || 20;
      meta.summary = meta.summary || '';
      meta.user_created = true;
    }
    const documentId = `${category}:${entityId}`;
    meta.els_id = documentId;
    meta.els_type = category;
    return { meta, category, documentId };
  }

  async applyRemoteDeletes(rows, fileById) {
    for (const row of rows) await this.removeRemoteDocument(row, fileById);
  }

  async createConflictCopy(local, remote, deleted = false) {
    if (!local && !deleted) return;
    const title = safeFileSegment(local?.title || remote?.title || '本机删除');
    const documentId = local?.document_id || remote?.document_id || 'unknown';
    const suffix = new Date().toISOString().replace(/[:.]/g, '-');
    const path = `${CONFLICTS_PATH}/${title}-本机版本-${suffix}.md`;
    await this.ensureFolder(CONFLICTS_PATH);
    const body = local ? local.markdown : `# 本机删除操作与云端修改发生冲突\n\n本机尝试删除这篇文档，但云端在此期间产生了新版本。为避免丢失云端内容，原文档已恢复为云端版本。请确认是否仍需删除。`;
    const copy = updateFrontmatter(body, {
      els_conflict_of: documentId,
      els_conflict_type: deleted ? 'local-delete-intent' : 'local-copy',
      els_conflict_revision: Number(remote?.revision) || 0
    });
    this.applyingRemote = true;
    try { await this.app.vault.create(path, copy); }
    finally { this.applyingRemote = false; }
  }

  async stampFileRevision(file, row) {
    const current = await this.app.vault.read(file);
    const stamped = updateFrontmatter(current, {
      els_id: row.document_id,
      els_type: row.category,
      els_revision: Number(row.revision) || 1,
      els_hash: row.content_hash || hashDocument(row),
      title: row.title || file.basename
    });
    this.applyingRemote = true;
    try { await this.app.vault.modify(file, stamped); }
    finally { this.applyingRemote = false; }
  }

  async syncNow() {
    if (this.syncRunning) { this.syncQueued = true; return; }
    this.syncRunning = true;
    try {
      const remoteDocs = await this.fetchRemoteDocs();
      const vault = await this.scanVault();
      const ids = new Set([...remoteDocs.keys(), ...vault.docs.keys(), ...Object.keys(this.settings.docs), ...Object.keys(this.settings.pendingDeletes)]);
      const applyRows = [];
      const pushRows = [];
      const tombstones = [];
      const nextMeta = { ...this.settings.docs };
      const conflictPairs = [];

      for (const id of ids) {
        const local = vault.docs.get(id) || null;
        const remote = remoteDocs.get(id) || null;
        const base = this.settings.docs[id] || null;
        const explicitlyDeleted = !!this.settings.pendingDeletes[id] || (!!base && !local && !vault.files.has(base.path));
        const localHash = local ? hashDocument(local) : null;
        const remoteDeleted = !!remote?.deleted_at;
        const remoteHash = remote && !remoteDeleted ? hashDocument(remote) : null;

        if (!base) {
          if (!remote) {
            if (local && !explicitlyDeleted) pushRows.push({ local, expected_revision: 0, deleted: false });
            continue;
          }
          if (remoteDeleted) {
            if (local) tombstones.push(remote);
            nextMeta[id] = this.metaFromRemote(remote, true);
          } else if (!local) {
            applyRows.push(remote);
            nextMeta[id] = this.metaFromRemote(remote, false);
          } else if (localHash === remoteHash) {
            nextMeta[id] = this.metaFromRemote(remote, false);
          } else {
            conflictPairs.push({ local, remote });
          }
          continue;
        }

        if (!remote) {
          if (local && !explicitlyDeleted) pushRows.push({ local, expected_revision: 0, deleted: false });
          continue;
        }

        const baseDeleted = !!base.deleted;
        const localChanged = explicitlyDeleted ? !baseDeleted : (local ? (baseDeleted || localHash !== base.hash) : !baseDeleted);
        const remoteChanged = remoteDeleted !== baseDeleted || (!remoteDeleted && remoteHash !== base.hash);
        if (localChanged && remoteChanged) {
          if ((explicitlyDeleted && remoteDeleted) || (local && !remoteDeleted && localHash === remoteHash)) {
            nextMeta[id] = this.metaFromRemote(remote, remoteDeleted);
            delete this.settings.pendingDeletes[id];
          } else conflictPairs.push({ local: explicitlyDeleted ? null : local, remote, deleted: explicitlyDeleted });
        } else if (remoteChanged) {
          if (remoteDeleted) tombstones.push(remote);
          else applyRows.push(remote);
          nextMeta[id] = this.metaFromRemote(remote, remoteDeleted);
          if (remoteDeleted) delete this.settings.pendingDeletes[id];
        } else if (localChanged) {
          if (explicitlyDeleted || !local) pushRows.push({ local: null, previous: remote, document_id: id, expected_revision: remote.revision, deleted: true });
          else pushRows.push({ local, expected_revision: remote.revision, deleted: false });
        } else {
          nextMeta[id] = this.metaFromRemote(remote, remoteDeleted);
        }
      }

      const fileById = new Map(Array.from(vault.files.values()).map(file => [file.path, file]));
      const filesById = new Map();
      for (const file of vault.files.values()) {
        const known = this.knownFiles.get(file.path);
        if (known?.document_id) filesById.set(known.document_id, file);
      }
      await this.applyRemoteDeletes(tombstones, filesById);
      for (const row of applyRows) await this.writeRemoteDocument(row, filesById);

      if (pushRows.length) {
        const payload = pushRows.map(item => {
          const row = item.local || item.previous || {};
          const local = item.local;
          const category = local?.category || row.category;
          const path = local?.path || row.path || '';
          const title = local?.title || row.title || '';
          const markdown = local?.markdown || row.markdown || '';
          const id = local?.document_id || item.document_id;
          return {
            document_id: id,
            category,
            path,
            title,
            markdown,
            content_hash: local ? hashDocument(local) : (row.content_hash || hashDocument({ category, path, title, markdown })),
            expected_revision: item.expected_revision,
            deleted: !!item.deleted
          };
        });
        const results = await this.pushBatch(payload);
        for (let i = 0; i < results.length; i++) {
          const result = results[i];
          const item = pushRows[i];
          const row = result?.document;
          if (result?.ok && row) {
            nextMeta[row.document_id] = this.metaFromRemote(row, !!row.deleted_at);
            delete this.settings.pendingDeletes[row.document_id];
            if (item.local) {
              const file = vault.files.get(item.local.path);
              if (file) await this.stampFileRevision(file, row);
            }
          } else if (result?.conflict && row) {
            conflictPairs.push({ local: item.local, remote: row, deleted: !!item.deleted });
          } else {
            throw new Error('一篇笔记未能写入 Supabase，服务器未确认同步结果。');
          }
        }
      }

      for (const pair of conflictPairs) {
        await this.createConflictCopy(pair.local, pair.remote, !!pair.deleted);
        if (pair.remote?.deleted_at) await this.applyRemoteDeletes([pair.remote], filesById);
        else if (pair.remote) await this.writeRemoteDocument(pair.remote, filesById);
        if (pair.remote) nextMeta[pair.remote.document_id] = this.metaFromRemote(pair.remote, !!pair.remote.deleted_at);
        if (pair.local) new Notice(`检测到并发修改，已保存本机副本：${pair.local.title}`);
      }

      this.settings.docs = nextMeta;
      this.settings.pendingDeletes = this.settings.pendingDeletes || {};
      await this.saveSettings();
      const touched = applyRows.length + tombstones.length + pushRows.length;
      const summary = conflictPairs.length
        ? `同步完成；${conflictPairs.length} 篇笔记有并发修改，本机版本已复制到「${CONFLICTS_PATH}」。`
        : touched ? `同步完成：导入 ${applyRows.length}、删除 ${tombstones.length}、上传 ${pushRows.length} 篇文档。` : 'Obsidian 文档已是最新状态。';
      new Notice(summary, 7000);
      this.statusBar?.setText?.(conflictPairs.length ? `Obsidian 冲突 ${conflictPairs.length}` : 'Obsidian 已同步');
    } catch (error) {
      this.statusBar?.setText?.('Obsidian 同步异常');
      throw error;
    } finally {
      this.syncRunning = false;
      if (this.syncQueued) {
        this.syncQueued = false;
        this.scheduleSync(700);
      }
    }
  }

  metaFromRemote(row, deleted) {
    return {
      hash: row.content_hash || hashDocument(row),
      revision: Number(row.revision) || 1,
      deleted: !!deleted,
      category: row.category,
      path: row.path || '',
      title: row.title || '',
      updatedAt: row.updated_at || new Date().toISOString()
    };
  }

  reportError(error) {
    this.logError(error);
    new Notice(`Obsidian 同步失败：${error?.message || error}`, 9000);
  }

  logError(error) {
    console.error('[Embedded Learning Bridge]', error);
  }
}

class EmbeddedLearningBridgeSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    const plugin = this.plugin;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Embedded Learning Bridge' });
    containerEl.createEl('p', { text: '使用同一 Supabase 账号，将网站知识库、学习记录、课程笔记和资源收藏与当前 Vault 双向同步。' });

    new Setting(containerEl).setName('Supabase Project URL').setDesc('例如 https://your-project.supabase.co').addText(text =>
      text.setPlaceholder('https://your-project.supabase.co').setValue(plugin.settings.supabaseUrl).onChange(async value => {
        plugin.settings.supabaseUrl = value.trim(); await plugin.saveSettings();
      }));

    new Setting(containerEl).setName('Publishable key / anon key').setDesc('只能使用公开 publishable / anon key，不要填写 service_role 或 secret key。').addText(text =>
      text.setPlaceholder('sb_publishable_… 或 anon key').setValue(plugin.settings.publishableKey).onChange(async value => {
        plugin.settings.publishableKey = value.trim(); await plugin.saveSettings();
      }));

    new Setting(containerEl).setName('Supabase 邮箱').addText(text =>
      text.setPlaceholder('name@example.com').setValue(plugin.settings.email).onChange(async value => {
        plugin.settings.email = value.trim(); await plugin.saveSettings();
      }));

    let password = '';
    new Setting(containerEl).setName('账号密码').setDesc('密码仅用于本次登录请求，不会保存在插件设置中。').addText(text => {
      text.inputEl.type = 'password';
      text.setPlaceholder('输入 Supabase 账号密码').onChange(value => { password = value; });
    }).addButton(button => button.setButtonText('登录并开始同步').setCta().onClick(async () => {
      try {
        await plugin.signIn(plugin.settings.email, password);
        password = '';
        this.display();
      } catch (error) { plugin.reportError(error); }
    }));

    new Setting(containerEl).setName('当前账号').setDesc(plugin.settings.userId ? `${plugin.settings.email || '已登录'} · ${plugin.settings.userId}` : '尚未登录');

    new Setting(containerEl).addButton(button => button.setButtonText('立即同步').setCta().onClick(() =>
      plugin.syncNow().catch(error => plugin.reportError(error))
    )).addButton(button => button.setButtonText('退出登录').setWarning().onClick(() =>
      plugin.signOut().then(() => this.display()).catch(error => plugin.reportError(error))
    ));

    new Setting(containerEl).setName('自动检查间隔（秒）').setDesc('移动端后台运行可能被系统暂停；回到 Obsidian 时会自动补同步。').addSlider(slider =>
      slider.setLimits(15, 180, 5).setValue(Number(plugin.settings.syncIntervalSeconds) || 25).setDynamicTooltip().onChange(async value => {
        plugin.settings.syncIntervalSeconds = value;
        await plugin.saveSettings();
        if (plugin.pollTimer) window.clearInterval(plugin.pollTimer);
        plugin.pollTimer = window.setInterval(() => {
          if (document.visibilityState !== 'hidden' && plugin.settings.refreshToken) plugin.syncNow().catch(error => plugin.logError(error));
        }, value * 1000);
      }));

    containerEl.createEl('p', { text: '提示：每台设备都需单独登录一次。若使用 Obsidian Sync 同步设置，请不要把本插件的 data.json 在设备间共用，以免 Supabase 刷新令牌互相覆盖。冲突时，本机版本会另存到「嵌入式学习站/同步冲突」，原文件采用云端最新版本。' });
  }
}

module.exports = EmbeddedLearningBridge;
