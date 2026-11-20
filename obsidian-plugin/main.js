const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const Notice = obsidian.Notice;
const PluginSettingTab = obsidian.PluginSettingTab;
const FuzzySuggestModal = obsidian.FuzzySuggestModal;
const Modal = obsidian.Modal;
const Setting = obsidian.Setting;
const requestUrl = obsidian.requestUrl;
const normalizePath = obsidian.normalizePath;
const TFile = obsidian.TFile;
const TFolder = obsidian.TFolder;

const PLUGIN_ID = 'embedded-learning-hub-sync';
const TABLE = 'embedded_learning_workspaces';
const AUTH_STORAGE_KEY = 'elh-obsidian-sync-auth-v1';
function assertPublicKey(value) {
  const key = String(value || '').trim();
  if (!key) throw new Error('请填写 Supabase publishable/anon 公共密钥。');
  if (/service_role|sb_secret_/i.test(key)) throw new Error('检测到疑似 Supabase secret/service_role 密钥。此类密钥不能放入网页或 Obsidian 插件，请改用 publishable/anon 公共密钥。');
  // Legacy anon/service_role keys are JWTs. Reject a service_role token even if its
  // encoded payload does not contain the literal role name in the original string.
  const parts = key.split('.');
  if (parts.length === 3) {
    try {
      const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      const decoded = JSON.parse(decodeURIComponent(Array.from(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, '='))).map(ch => '%' + ch.charCodeAt(0).toString(16).padStart(2, '0')).join('')));
      if (String(decoded.role || '').toLowerCase() === 'service_role') throw new Error('检测到 Supabase service_role 密钥。请改用 anon 公共密钥。');
    } catch (error) {
      if (error && /service_role/.test(error.message || '')) throw error;
      // Non-JWT publishable keys and malformed legacy tokens are validated by Supabase.
    }
  }
  return key;
}

const DEFAULT_SETTINGS = {
  supabaseUrl: '',
  publishableKey: '',
  email: '',
  rootFolder: 'Embedded Learning Hub',
  autoSync: true,
  intervalSeconds: 90,
  syncKnowledge: true,
  syncRecords: true,
  syncCourses: true,
  syncResources: true,
  manifest: { items: {} }
};

function clone(value) { return JSON.parse(JSON.stringify(value)); }
function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => stableStringify(v) ?? 'null').join(',') + ']';
  const keys = Object.keys(value).filter(k => typeof value[k] !== 'undefined').sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
function hash(value) {
  const text = typeof value === 'string' ? value : stableStringify(value);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + text.length;
}
function makeId(prefix) {
  let id;
  try { id = crypto.randomUUID(); }
  catch (_) { id = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12); }
  return (prefix ? prefix + '-' : '') + id;
}
function escHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function yamlValue(value) { return JSON.stringify(value ?? ''); }
function parseYamlValue(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  try { return JSON.parse(raw); } catch (_) { return raw.replace(/^['"]|['"]$/g, ''); }
}
function parseFrontmatter(markdown) {
  const text = String(markdown || '').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!text.startsWith('---\n')) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const end = text.indexOf('\n---', 4);
  if (end < 0) return { frontmatter: {}, body: text, hasFrontmatter: false };
  const block = text.slice(4, end);
  const frontmatter = {};
  for (const line of block.split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) frontmatter[match[1]] = parseYamlValue(match[2]);
  }
  const body = text.slice(end + 4).replace(/^\n/, '');
  return { frontmatter, body, hasFrontmatter: true };
}
function encodeBase64Unicode(text) {
  try { return btoa(unescape(encodeURIComponent(String(text)))); }
  catch (_) { return ''; }
}
function decodeBase64Unicode(text) {
  try { return decodeURIComponent(escape(atob(String(text)))); }
  catch (_) { return ''; }
}
function splitOriginalHtml(body) {
  const match = String(body || '').match(/\n?<!--\s*ELH_ORIGINAL_HTML_BASE64:([A-Za-z0-9+/=]+)\s*-->\s*$/);
  if (!match) return { body: String(body || '').replace(/\s+$/, ''), originalHtml: '' };
  return { body: String(body || '').slice(0, match.index).replace(/\s+$/, ''), originalHtml: decodeBase64Unicode(match[1]) };
}
function htmlToMarkdown(html) {
  const source = String(html || '');
  if (!/<\/?[a-z][^>]*>/i.test(source)) return source.trim();
  if (typeof DOMParser === 'undefined') return source.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(p|div|h[1-6]|li|pre|blockquote)>/gi, '\n\n').replace(/<[^>]+>/g, '').trim();
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const walk = node => {
    if (node.nodeType === 3) return node.nodeValue || '';
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toLowerCase();
    const inner = Array.from(node.childNodes).map(walk).join('');
    if (tag === 'br') return '\n';
    if (tag === 'strong' || tag === 'b') return '**' + inner + '**';
    if (tag === 'em' || tag === 'i') return '*' + inner + '*';
    if (tag === 'code' && node.parentElement?.tagName.toLowerCase() !== 'pre') return '`' + inner.replace(/`/g, '\\`') + '`';
    if (tag === 'pre') return '\n```text\n' + node.textContent + '\n```\n';
    if (/^h[1-6]$/.test(tag)) return '\n' + '#'.repeat(Number(tag.slice(1))) + ' ' + inner.trim() + '\n\n';
    if (tag === 'p' || tag === 'div') return inner.trim() ? inner.trim() + '\n\n' : '';
    if (tag === 'li') return '- ' + inner.trim() + '\n';
    if (tag === 'ul' || tag === 'ol') return '\n' + inner + '\n';
    if (tag === 'blockquote') return '\n' + inner.trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
    if (tag === 'a') return '[' + (inner || node.getAttribute('href') || '') + '](' + (node.getAttribute('href') || '') + ')';
    if (tag === 'img') return '![' + (node.getAttribute('alt') || '') + '](' + (node.getAttribute('src') || '') + ')';
    if (tag === 'hr') return '\n---\n\n';
    if (tag === 'td' || tag === 'th') return inner.trim() + ' | ';
    if (tag === 'tr') return '| ' + inner.trim().replace(/\s*\|\s*$/, '') + '\n';
    if (tag === 'table' || tag === 'thead' || tag === 'tbody') return '\n' + inner + '\n';
    return inner;
  };
  return Array.from(doc.body.childNodes).map(walk).join('').replace(/\n{3,}/g, '\n\n').trim();
}
function sanitizeRichHtml(html) {
  const source = String(html || '');
  if (typeof DOMParser === 'undefined') {
    return source
      .replace(/<\s*(script|style|iframe|object|embed|form|svg|math)\b[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|style|iframe|object|embed|form|svg|math)\b[^>]*\/?>/gi, '')
      .replace(/\s+on[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/\s+(href|src|srcdoc)\s*=\s*("|')\s*(?:javascript|vbscript):[\s\S]*?\2/gi, '')
      .replace(/\s+style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  }
  const doc = new DOMParser().parseFromString(source, 'text/html');
  const allowed = new Set(['DIV','P','BR','STRONG','B','EM','I','U','S','STRIKE','DEL','SUP','SUB','H1','H2','H3','H4','H5','H6','UL','OL','LI','BLOCKQUOTE','PRE','CODE','TABLE','THEAD','TBODY','TR','TH','TD','SPAN','IMG','A','HR']);
  const blocked = new Set(['SCRIPT','STYLE','IFRAME','OBJECT','EMBED','FORM','INPUT','BUTTON','TEXTAREA','VIDEO','AUDIO','SOURCE','SVG','MATH']);
  const visit = parent => {
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 8) { child.remove(); continue; }
      if (child.nodeType !== 1) continue;
      const tag = child.tagName;
      if (blocked.has(tag)) { child.remove(); continue; }
      if (!allowed.has(tag)) { child.replaceWith(...Array.from(child.childNodes)); continue; }
      for (const attr of Array.from(child.attributes)) {
        const name = attr.name.toLowerCase();
        const value = attr.value;
        let keep = ['alt','title'].includes(name);
        if (tag === 'A' && name === 'href') {
          try { keep = ['http:','https:','mailto:'].includes(new URL(value).protocol); } catch (_) { keep = false; }
        }
        if (tag === 'IMG' && name === 'src') {
          keep = /^https?:\/\//i.test(value) || /^data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z0-9+/=]+$/i.test(value);
        }
        if (['IMG','TH','TD'].includes(tag) && ['width','height','colspan','rowspan'].includes(name)) keep = /^\d{1,4}$/.test(value);
        if (tag === 'CODE' && name === 'class') keep = /^(?:language-[a-z0-9_-]+\s*)+$/i.test(value);
        if (!keep) child.removeAttribute(attr.name);
      }
      if (tag === 'A' && child.hasAttribute('href')) { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer'); }
      if (tag === 'IMG' && !child.hasAttribute('src')) { child.remove(); continue; }
      visit(child);
    }
  };
  visit(doc.body);
  return doc.body.innerHTML;
}
function markdownInlineToHtml(text) {
  let value = escHtml(text);
  value = value.replace(/`([^`]+)`/g, '<code>$1</code>');
  value = value.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  value = value.replace(/\*(.+?)\*/g, '<em>$1</em>');
  value = value.replace(/!\[([^\]]*)\]\((https?:\/\/[^\s)]+|data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g, '<img alt="$1" src="$2">');
  value = value.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  return value;
}
function markdownToHtml(markdown) {
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  const output = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => { if (paragraph.length) { output.push('<p>' + paragraph.map(markdownInlineToHtml).join('<br>') + '</p>'); paragraph = []; } };
  const flushList = () => { if (list) { output.push('<' + list.type + '>' + list.items.map(x => '<li>' + markdownInlineToHtml(x) + '</li>').join('') + '</' + list.type + '>'); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*```/.test(line)) {
      flushParagraph(); flushList();
      if (code === null) code = [];
      else { output.push('<pre><code>' + escHtml(code.join('\n')) + '</code></pre>'); code = null; }
      continue;
    }
    if (code !== null) { code.push(line); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      flushParagraph(); flushList();
      const tableRows = [line];
      while (i + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[i + 1])) tableRows.push(lines[++i]);
      const cells = row => row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
      const isSeparator = row => cells(row).length > 0 && cells(row).every(cell => /^:?-{3,}:?$/.test(cell));
      const headerCells = cells(tableRows[0]);
      const hasSeparator = tableRows.length > 1 && isSeparator(tableRows[1]);
      const bodyRows = tableRows.slice(hasSeparator ? 2 : 1).map(cells);
      const headerHtml = '<thead><tr>' + headerCells.map(cell => '<th>' + markdownInlineToHtml(cell) + '</th>').join('') + '</tr></thead>';
      const bodyHtml = '<tbody>' + bodyRows.map(row => '<tr>' + headerCells.map((_, index) => '<td>' + markdownInlineToHtml(row[index] || '') + '</td>').join('') + '</tr>').join('') + '</tbody>';
      output.push('<table>' + headerHtml + bodyHtml + '</table>');
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) { flushParagraph(); flushList(); const level = heading[1].length; output.push('<h' + level + '>' + markdownInlineToHtml(heading[2]) + '</h' + level + '>'); continue; }
    const bullet = line.match(/^\s*[-*+]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    if (bullet || numbered) {
      flushParagraph(); const type = bullet ? 'ul' : 'ol';
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((bullet || numbered)[1]); continue;
    }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    if (/^>\s?/.test(line)) { flushParagraph(); flushList(); output.push('<blockquote>' + markdownInlineToHtml(line.replace(/^>\s?/, '')) + '</blockquote>'); continue; }
    paragraph.push(line);
  }
  if (code !== null) output.push('<pre><code>' + escHtml(code.join('\n')) + '</code></pre>');
  flushParagraph(); flushList();
  return output.join('');
}
function legacySafeSlug(value) {
  const slug = String(value || '未命名').normalize('NFKC').replace(/[\\/:*?"<>|]/g, '-').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 72);
  return slug || '未命名';
}
function safeSlug(value) {
  const slug = legacySafeSlug(value);
  // Obsidian hides dot-prefixed files/folders by default and its Vault API
  // does not reliably expose those paths. Keep the original title in YAML,
  // but make the on-disk Markdown path visible and indexable.
  return slug.startsWith('.') ? '笔记-' + slug : slug;
}
function itemKey(type, id) { return String(type) + ':' + String(id); }
function normalizedHttpUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch (_) { return ''; }
}
function toDateText(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}

function buildItemFromFrontmatter(frontmatter, body) {
  const type = String(frontmatter.elh_type || '').toLowerCase();
  if (!['knowledge', 'record', 'resource', 'course', 'lesson'].includes(type)) return null;
  const split = splitOriginalHtml(body);
  const markdownBody = split.body;
  const bodyHash = hash(markdownBody);
  const content = sanitizeRichHtml(split.originalHtml && String(frontmatter.elh_body_hash || '') === bodyHash
    ? split.originalHtml : markdownToHtml(markdownBody));
  const id = String(frontmatter.elh_id || '');
  if (type === 'knowledge') return { type, id, title: String(frontmatter.title || '未命名知识卡片'), category: String(frontmatter.category || '自定义'), content, createdAt: String(frontmatter.created_at || new Date().toISOString()), updatedAt: String(frontmatter.updated_at || ''), custom: true, markdownBody };
  if (type === 'record') {
    return { type, id, title: String(frontmatter.title || '未命名学习记录'), date: toDateText(frontmatter.date), minutes: Math.max(1, Math.min(1440, Number(frontmatter.minutes) || 30)), category: String(frontmatter.category || '自定义'), content: markdownBody.trim(), next: String(frontmatter.next || ''), createdAt: String(frontmatter.created_at || new Date().toISOString()), updatedAt: String(frontmatter.updated_at || new Date().toISOString()), markdownBody };
  }
  if (type === 'resource') return { type, id, title: String(frontmatter.title || '未命名资源'), url: String(frontmatter.url || ''), category: String(frontmatter.category || '自定义'), tag: String(frontmatter.tag || 'MY RESOURCE'), desc: markdownBody.trim(), custom: true, updatedAt: String(frontmatter.updated_at || new Date().toISOString()) };
  if (type === 'course') return { type, id, title: String(frontmatter.title || '未命名课程'), category: String(frontmatter.category || '自定义'), level: String(frontmatter.level || '自定义'), duration: String(frontmatter.duration || '自定义'), desc: markdownBody.trim() || String(frontmatter.desc || ''), stages: Array.isArray(frontmatter.stages) ? frontmatter.stages : [], custom: true, color: String(frontmatter.color || 'mint'), icon: String(frontmatter.icon || 'book'), code: String(frontmatter.code || 'OBSIDIAN'), updatedAt: String(frontmatter.updated_at || new Date().toISOString()) };
  return { type, id, courseId: String(frontmatter.course_id || ''), title: String(frontmatter.title || '未命名课时'), stage: String(frontmatter.stage || '补充与拓展'), minutes: Math.max(1, Math.min(600, Number(frontmatter.minutes) || 20)), summary: String(frontmatter.summary || ''), content, takeaways: Array.isArray(frontmatter.takeaways) ? frontmatter.takeaways : [], exercise: String(frontmatter.exercise || ''), exerciseAnswer: String(frontmatter.exercise_answer || ''), reference: String(frontmatter.reference || ''), completed: !!frontmatter.completed, markdownBody, updatedAt: String(frontmatter.updated_at || new Date().toISOString()) };
}
function itemFromWorkspace(type, raw, extra = {}) {
  if (type === 'knowledge') return { type, ...clone(raw) };
  if (type === 'record') return { type, ...clone(raw) };
  if (type === 'resource') return { type, ...clone(raw) };
  return { type, ...clone(raw), ...extra };
}

function itemToMarkdown(item) {
  const type = item.type;
  let fm = { elh_type: type, elh_id: item.id, title: item.title || '' };
  let body = '';
  let originalHtml = '';
  if (type === 'knowledge') {
    fm.category = item.category || '自定义'; fm.created_at = item.createdAt || ''; fm.updated_at = item.updatedAt || '';
    originalHtml = String(item.content || ''); body = htmlToMarkdown(originalHtml);
  } else if (type === 'record') {
    fm.date = toDateText(item.date); fm.minutes = Number(item.minutes) || 30; fm.category = item.category || '自定义';
    fm.created_at = item.createdAt || ''; fm.updated_at = item.updatedAt || ''; fm.next = item.next || '';
    body = String(item.content || '').trim();
  } else if (type === 'resource') {
    fm.url = item.url || ''; fm.category = item.category || '自定义'; fm.tag = item.tag || 'MY RESOURCE'; fm.updated_at = item.updatedAt || '';
    body = String(item.desc || '').trim();
  } else if (type === 'course') {
    fm.category = item.category || '自定义'; fm.level = item.level || '自定义'; fm.duration = item.duration || '自定义';
    fm.color = item.color || 'mint'; fm.icon = item.icon || 'book'; fm.code = item.code || ''; fm.stages = Array.isArray(item.stages) ? item.stages : []; fm.updated_at = item.updatedAt || '';
    body = String(item.desc || '').trim();
  } else if (type === 'lesson') {
    fm.course_id = item.courseId || ''; fm.stage = item.stage || '补充与拓展'; fm.minutes = Number(item.minutes) || 20;
    fm.summary = item.summary || ''; fm.takeaways = Array.isArray(item.takeaways) ? item.takeaways : [];
    fm.exercise = item.exercise || ''; fm.exercise_answer = item.exerciseAnswer || ''; fm.reference = item.reference || '';
    fm.completed = !!item.completed; fm.updated_at = item.updatedAt || '';
    originalHtml = String(item.content || ''); body = htmlToMarkdown(originalHtml);
  }
  fm.elh_body_hash = hash(body);
  const lines = ['---'];
  for (const [key, value] of Object.entries(fm)) lines.push(key + ': ' + yamlValue(value));
  lines.push('---', '', body);
  if (originalHtml) lines.push('', '<!-- ELH_ORIGINAL_HTML_BASE64:' + encodeBase64Unicode(originalHtml) + ' -->');
  return lines.join('\n').trimEnd() + '\n';
}
function itemFilePathWithSlug(root, item, slugger) {
  const typeFolder = { knowledge: '知识库', record: '学习记录', resource: '资源', course: '课程笔记', lesson: '课程笔记' }[item.type] || '其他';
  const suffix = String(item.id || 'new').replace(/[^A-Za-z0-9_-]/g, '').slice(-10) || 'new';
  if (item.type === 'lesson') { const courseSuffix = String(item.courseId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-10) || 'course'; return normalizePath(root + '/' + typeFolder + '/' + slugger(item.courseTitle || item.courseId || '未分类课程') + '--' + courseSuffix + '/' + slugger(item.title) + '--' + suffix + '.md'); }
  if (item.type === 'course') return normalizePath(root + '/' + typeFolder + '/' + slugger(item.title) + '--' + suffix + '/课程.md');
  return normalizePath(root + '/' + typeFolder + '/' + slugger(item.title) + '--' + suffix + '.md');
}
function itemFilePath(root, item) { return itemFilePathWithSlug(root, item, safeSlug); }
function legacyItemFilePath(root, item) { return itemFilePathWithSlug(root, item, legacySafeSlug); }
function ensureVisibleMarkdownPath(path) {
  const normalized = normalizePath(path);
  const slash = normalized.lastIndexOf('/');
  const parent = slash >= 0 ? normalized.slice(0, slash) : '';
  const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
  // A leading dot makes a note invisible to Obsidian by default. Prefix only
  // the filename; frontmatter title and note body remain unchanged.
  const visibleFilename = filename.startsWith('.') ? '笔记-' + filename : filename;
  return normalizePath((parent ? parent + '/' : '') + visibleFilename);
}
function workspaceToItems(state) {
  const items = new Map();
  for (const note of state.notes || []) if (note && note.id) items.set(itemKey('knowledge', note.id), itemFromWorkspace('knowledge', note));
  for (const record of state.records || []) if (record && record.id) items.set(itemKey('record', record.id), itemFromWorkspace('record', record));
  for (const resource of state.resources || []) if (resource && resource.id) items.set(itemKey('resource', resource.id), itemFromWorkspace('resource', resource));
  const courses = state.obsidianCatalog && Array.isArray(state.obsidianCatalog.courses) ? state.obsidianCatalog.courses : null;
  if (!courses) throw new Error('云端工作区尚未包含 Obsidian 课程索引。请先将学习网站部署到 V19 或更高版本，登录并等待一次云同步完成，再连接 Obsidian。');
  for (const course of courses) {
    if (!course || !course.id) continue;
    const courseItem = { type: 'course', ...clone(course) };
    items.set(itemKey('course', course.id), courseItem);
    for (const lesson of course.lessons || []) {
      if (!lesson || !lesson.id) continue;
      items.set(itemKey('lesson', lesson.id), { type: 'lesson', ...clone(lesson), courseId: course.id, courseTitle: course.title });
    }
  }
  return items;
}
function ensureArrayState(state, key) { if (!Array.isArray(state[key])) state[key] = []; return state[key]; }
function ensureObjectState(state, key) { if (!state[key] || typeof state[key] !== 'object' || Array.isArray(state[key])) state[key] = {}; return state[key]; }
function updateCatalogItem(state, item) {
  if (!state.obsidianCatalog || !Array.isArray(state.obsidianCatalog.courses)) state.obsidianCatalog = { version: 1, courses: [] };
  const courses = state.obsidianCatalog.courses;
  if (item.type === 'course') {
    const index = courses.findIndex(c => c.id === item.id);
    const existing = index >= 0 ? courses[index] : { id: item.id, lessons: [] };
    const updated = { ...existing, title: item.title, category: item.category, level: item.level, duration: item.duration, desc: item.desc, color: item.color, icon: item.icon, code: item.code, stages: Array.isArray(item.stages) ? item.stages : existing.stages || [], custom: item.custom ?? existing.custom, lessons: existing.lessons || [] };
    if (index >= 0) courses[index] = updated; else courses.push(updated);
  } else if (item.type === 'lesson') {
    const course = courses.find(c => c.id === item.courseId);
    if (course) {
      course.lessons = Array.isArray(course.lessons) ? course.lessons : [];
      const index = course.lessons.findIndex(l => l.id === item.id);
      const updated = { ...(index >= 0 ? course.lessons[index] : {}), id: item.id, title: item.title, stage: item.stage, minutes: item.minutes, summary: item.summary, content: item.content, takeaways: item.takeaways, exercise: item.exercise, exerciseAnswer: item.exerciseAnswer, reference: item.reference, completed: !!item.completed };
      if (index >= 0) course.lessons[index] = updated; else course.lessons.push(updated);
    }
  }
}
function upsertWorkspaceItem(state, item) {
  const now = new Date().toISOString();
  if (item.type === 'knowledge') {
    const list = ensureArrayState(state, 'notes');
    const existing = list.find(x => x.id === item.id);
    const value = { id: item.id, title: item.title, category: item.category || '自定义', content: item.content || '', createdAt: item.createdAt || existing?.createdAt || now, updatedAt: now, custom: true };
    if (existing) Object.assign(existing, value); else list.push(value);
  } else if (item.type === 'record') {
    const list = ensureArrayState(state, 'records');
    const existing = list.find(x => x.id === item.id);
    const value = { id: item.id, title: item.title, date: toDateText(item.date), minutes: Number(item.minutes) || 30, category: item.category || '自定义', content: item.content || '', next: item.next || '', createdAt: item.createdAt || existing?.createdAt || now, updatedAt: now };
    if (existing) Object.assign(existing, value); else list.push(value);
  } else if (item.type === 'resource') {
    const list = ensureArrayState(state, 'resources');
    const existing = list.find(x => x.id === item.id);
    const normalizedUrl = normalizedHttpUrl(item.url);
    if (!normalizedUrl) throw new Error('请为资源「' + item.title + '」填写有效的 http:// 或 https:// 链接后再同步。');
    const duplicate = normalizedUrl && list.find(x => x.id !== item.id && normalizedHttpUrl(x.url) === normalizedUrl);
    if (duplicate) throw new Error('资源链接已被「' + duplicate.title + '」使用，请先合并或更换链接：' + item.title);
    const value = { id: item.id, title: item.title, url: item.url || '', category: item.category || '自定义', tag: item.tag || 'MY RESOURCE', desc: item.desc || '', updatedAt: now, custom: true };
    if (existing) Object.assign(existing, value); else list.push(value);
  } else if (item.type === 'course') {
    const courses = ensureArrayState(state, 'customCourses');
    const base = courses.find(c => c.id === item.id);
    if (!base) courses.push({ id: item.id, title: item.title, category: item.category || '自定义', level: item.level || '自定义', duration: item.duration || '自定义', desc: item.desc || '', color: item.color || 'mint', icon: item.icon || 'book', code: item.code || 'OBSIDIAN', custom: true, lessons: [] });
    const edits = ensureObjectState(state, 'courseEdits');
    edits[item.id] = { ...(edits[item.id] || {}), title: item.title, category: item.category, level: item.level, duration: item.duration, desc: item.desc };
    if (Array.isArray(item.stages)) {
      const stageEdits = ensureObjectState(state, 'stageEdits');
      for (const stage of item.stages) {
        if (!stage || !stage.name) continue;
        const key = item.id + '::' + String(stage.name);
        stageEdits[key] = { ...(stageEdits[key] || {}), title: String(stage.title || stage.name), goal: String(stage.goal || '') };
      }
    }
    updateCatalogItem(state, item);
  } else if (item.type === 'lesson') {
    const catalog = state.obsidianCatalog && state.obsidianCatalog.courses || [];
    const course = catalog.find(c => c.id === item.courseId);
    if (!course) throw new Error('课时所属课程不存在：' + item.courseId);
    const baseLesson = (course.lessons || []).find(l => l.id === item.id);
    if (!baseLesson) {
      const added = ensureObjectState(state, 'addedLessons');
      if (!Array.isArray(added[item.courseId])) added[item.courseId] = [];
      if (!added[item.courseId].some(l => l.id === item.id)) added[item.courseId].push({ id: item.id, title: item.title, stage: item.stage, minutes: item.minutes, summary: item.summary, editableContent: item.content, userEdited: true, sections: [], takeaways: item.takeaways || [], exercise: item.exercise || '', exerciseAnswer: item.exerciseAnswer || '', reference: item.reference || '', custom: true, userCreated: true });
    }
    const edits = ensureObjectState(state, 'lessonEdits');
    edits[item.id] = { ...(edits[item.id] || {}), title: item.title, stage: item.stage, minutes: item.minutes, summary: item.summary, editableContent: item.content || '', userEdited: true, sections: [], takeaways: item.takeaways || [], exercise: item.exercise || '', exerciseAnswer: item.exerciseAnswer || '', reference: item.reference || '' };
    const done = ensureArrayState(state, 'completedLessons');
    const position = done.indexOf(item.id);
    if (item.completed && position < 0) done.push(item.id);
    if (!item.completed && position >= 0) done.splice(position, 1);
    updateCatalogItem(state, item);
  }
}
function removeWorkspaceItem(state, item) {
  if (item.type === 'knowledge') state.notes = (state.notes || []).filter(x => x.id !== item.id);
  else if (item.type === 'record') state.records = (state.records || []).filter(x => x.id !== item.id);
  else if (item.type === 'resource') state.resources = (state.resources || []).filter(x => x.id !== item.id);
  else if (item.type === 'lesson') {
    state.deletedLessonIds = Array.from(new Set([...(state.deletedLessonIds || []), item.id]));
    state.completedLessons = (state.completedLessons || []).filter(x => x !== item.id);
    if (state.lessonEdits) delete state.lessonEdits[item.id];
    if (state.addedLessons && state.addedLessons[item.courseId]) state.addedLessons[item.courseId] = state.addedLessons[item.courseId].filter(x => x.id !== item.id);
    const course = state.obsidianCatalog?.courses?.find(c => c.id === item.courseId);
    if (course) course.lessons = (course.lessons || []).filter(x => x.id !== item.id);
  } else if (item.type === 'course') {
    const catalogCourse = state.obsidianCatalog?.courses?.find(c => c.id === item.id);
    const lessonIds = (catalogCourse?.lessons || []).map(lesson => lesson.id);
    state.deletedCourseIds = Array.from(new Set([...(state.deletedCourseIds || []), item.id]));
    state.customCourses = (state.customCourses || []).filter(x => x.id !== item.id);
    if (state.courseEdits) delete state.courseEdits[item.id];
    if (state.addedLessons) delete state.addedLessons[item.id];
    if (state.stageEdits) for (const key of Object.keys(state.stageEdits)) if (key.startsWith(item.id + '::')) delete state.stageEdits[key];
    state.deletedLessonIds = Array.from(new Set([...(state.deletedLessonIds || []), ...lessonIds]));
    state.completedLessons = (state.completedLessons || []).filter(id => !lessonIds.includes(id));
    if (state.lessonEdits) for (const id of lessonIds) delete state.lessonEdits[id];
    if (state.obsidianCatalog) state.obsidianCatalog.courses = (state.obsidianCatalog.courses || []).filter(x => x.id !== item.id);
  }
}
function normalizeRoot(value) { return normalizePath(String(value || DEFAULT_SETTINGS.rootFolder).replace(/^\/+|\/+$/g, '')) || DEFAULT_SETTINGS.rootFolder; }

class CoursePickerModal extends FuzzySuggestModal {
  constructor(app, courses, onChoose) {
    super(app);
    this.courses = courses;
    this.onChoose = onChoose;
    this.setPlaceholder('选择要添加课时的课程…');
  }
  getItems() { return this.courses; }
  getItemText(course) { return String(course.title || '未命名课程') + ' · ' + String(course.id || ''); }
  onChooseItem(course) { if (course && this.onChoose) this.onChoose(course); }
}

class EmbeddedLearningHubSyncPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData() || {});
    this.settings.manifest = this.settings.manifest && this.settings.manifest.items ? this.settings.manifest : { items: {} };
    this.syncing = false;
    this.applying = false;
    this.syncTimer = null;
    this.pollTimer = null;
    this.lastNotice = '';
    this.statusItem = this.addStatusBarItem();
    this.statusItem.setText('ELH · 未连接');
    this.addRibbonIcon('refresh-cw', '同步嵌入式学习站', () => this.syncNow(true));
    this.addCommand({ id: 'sync-now', name: '现在同步学习网站与 Obsidian', callback: () => this.syncNow(true) });
    this.addCommand({ id: 'diagnose-duplicate-sync-ids', name: '检查和整理重复同步 ID', callback: () => this.openDuplicateDiagnostics() });
    this.addCommand({ id: 'new-knowledge-note', name: '新建同步知识卡片', callback: () => this.createTemplateNote('knowledge') });
    this.addCommand({ id: 'new-learning-record', name: '新建同步学习记录', callback: () => this.createTemplateNote('record') });
    this.addCommand({ id: 'new-resource-note', name: '新建同步资源收藏', callback: () => this.createTemplateNote('resource') });
    this.addCommand({ id: 'new-course-note', name: '新建同步课程笔记', callback: () => this.createTemplateNote('course') });
    this.addCommand({ id: 'new-lesson-note', name: '在现有课程中新建同步课时笔记', callback: () => this.chooseCourseForNewLesson() });
    this.addSettingTab(new EmbeddedLearningHubSettingTab(this.app, this));
    this.registerDomEvent(window, 'focus', () => this.syncIfConfigured('focus'));
    this.registerDomEvent(window, 'online', () => this.syncIfConfigured('online'));
    this.registerDomEvent(document, 'visibilitychange', () => { if (!document.hidden) this.syncIfConfigured('visible'); });
    this.app.workspace.onLayoutReady(() => {
      this.registerVaultEvents();
      this.startPolling();
      this.syncIfConfigured('startup');
    });
  }

  onunload() {
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    if (this.pollTimer) window.clearInterval(this.pollTimer);
  }

  async saveSettings() {
    this.settings.rootFolder = normalizeRoot(this.settings.rootFolder);
    await this.saveData(this.settings);
    this.startPolling();
  }

  getAuthStore() {
    try { return JSON.parse(window.localStorage.getItem(AUTH_STORAGE_KEY) || '{}') || {}; }
    catch (_) { return {}; }
  }
  setAuthStore(value) {
    try { window.localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(value || {})); }
    catch (_) { throw new Error('无法保存本机登录会话，请检查 Obsidian 本地存储权限。'); }
  }
  clearAuthStore() { try { window.localStorage.removeItem(AUTH_STORAGE_KEY); } catch (_) {} }

  async requestJson(url, options = {}, auth = true, retried = false) {
    const publicKey = assertPublicKey(this.settings.publishableKey);
    const headers = Object.assign({ apikey: publicKey, 'Content-Type': 'application/json' }, options.headers || {});
    if (auth) {
      const session = await this.ensureAccessToken();
      headers.Authorization = 'Bearer ' + session.access_token;
    }
    const response = await requestUrl({ url, method: options.method || 'GET', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), throw: false });
    if (response.status === 401 && auth && !retried) {
      await this.refreshSession(true);
      return this.requestJson(url, options, auth, true);
    }
    if (response.status < 200 || response.status >= 300) {
      let detail = '';
      try { const payload = response.json || JSON.parse(response.text || '{}'); detail = payload.message || payload.msg || payload.error_description || payload.error || ''; } catch (_) {}
      throw new Error('Supabase 请求失败（HTTP ' + response.status + '）' + (detail ? '：' + detail : ''));
    }
    if (!response.text) return response.json || null;
    try { return response.json !== undefined ? response.json : JSON.parse(response.text); }
    catch (_) { return response.text; }
  }

  async login(email, password) {
    const emailText = String(email || '').trim();
    if (!this.settings.supabaseUrl) throw new Error('请先填写 Supabase Project URL。');
    assertPublicKey(this.settings.publishableKey);
    if (!emailText || !password) throw new Error('请填写已有学习网站账号的邮箱和密码。');
    const url = this.settings.supabaseUrl.replace(/\/+$/, '') + '/auth/v1/token?grant_type=password';
    const session = await this.requestJson(url, { method: 'POST', body: { email: emailText, password } }, false);
    if (!session || !session.access_token || !session.refresh_token) throw new Error('登录响应缺少会话令牌。');
    this.settings.email = emailText;
    this.setAuthStore({ access_token: session.access_token, refresh_token: session.refresh_token, expires_at: Date.now() + (Number(session.expires_in) || 3600) * 1000, user_id: session.user?.id || '' });
    await this.saveSettings();
    new Notice('已连接学习网站账号。');
    await this.syncNow(true);
  }

  async refreshSession(force = false) {
    const session = this.getAuthStore();
    if (!session.refresh_token) throw new Error('Obsidian 尚未登录，请在插件设置中使用学习网站账号登录。');
    if (!force && session.access_token && Number(session.expires_at || 0) > Date.now() + 60000) return session;
    const url = this.settings.supabaseUrl.replace(/\/+$/, '') + '/auth/v1/token?grant_type=refresh_token';
    const result = await this.requestJson(url, { method: 'POST', body: { refresh_token: session.refresh_token } }, false);
    if (!result || !result.access_token || !result.refresh_token) throw new Error('刷新登录会话失败，请重新登录。');
    const next = { access_token: result.access_token, refresh_token: result.refresh_token, expires_at: Date.now() + (Number(result.expires_in) || 3600) * 1000, user_id: result.user?.id || session.user_id || '' };
    this.setAuthStore(next);
    return next;
  }
  async ensureAccessToken() { return this.refreshSession(false); }

  async fetchWorkspace() {
    const auth = this.getAuthStore();
    if (!auth.user_id) throw new Error('登录会话中没有用户标识，请退出后重新登录。');
    const base = this.settings.supabaseUrl.replace(/\/+$/, '');
    const query = '?select=user_id,state,revision,updated_at&user_id=eq.' + encodeURIComponent(auth.user_id);
    const rows = await this.requestJson(base + '/rest/v1/' + TABLE + query);
    if (!Array.isArray(rows) || !rows.length) throw new Error('云端工作区不存在。请先在学习网站登录并完成首次云端数据迁移。');
    return rows[0];
  }

  async compareAndSwapWorkspace(row, state) {
    const base = this.settings.supabaseUrl.replace(/\/+$/, '');
    const auth = this.getAuthStore();
    const query = '?user_id=eq.' + encodeURIComponent(auth.user_id) + '&revision=eq.' + encodeURIComponent(String(row.revision));
    const response = await this.requestJson(base + '/rest/v1/' + TABLE + query, {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: { state, revision: Number(row.revision) + 1, updated_at: new Date().toISOString() }
    });
    if (!Array.isArray(response) || !response.length) return null;
    return response[0];
  }

  registerVaultEvents() {
    const relevant = file => file instanceof TFile && file.extension === 'md' && file.path.startsWith(this.settings.rootFolder + '/');
    this.registerEvent(this.app.vault.on('modify', file => { if (!this.applying && relevant(file)) this.scheduleSync(); }));
    this.registerEvent(this.app.vault.on('create', file => { if (!this.applying && relevant(file)) this.scheduleSync(); }));
    this.registerEvent(this.app.vault.on('delete', file => {
      if (!this.applying && file && String(file.path || '').startsWith(this.settings.rootFolder + '/')) this.scheduleSync();
    }));
    this.registerEvent(this.app.vault.on('rename', (file, oldPath) => {
      if (!this.applying && ((file && String(file.path || '').startsWith(this.settings.rootFolder + '/')) || String(oldPath || '').startsWith(this.settings.rootFolder + '/'))) this.scheduleSync();
    }));
  }

  startPolling() {
    if (this.pollTimer) window.clearInterval(this.pollTimer);
    this.pollTimer = null;
    if (!this.settings.autoSync) return;
    const seconds = Math.max(30, Math.min(900, Number(this.settings.intervalSeconds) || 90));
    this.pollTimer = window.setInterval(() => this.syncIfConfigured('interval'), seconds * 1000);
    this.registerInterval(this.pollTimer);
  }

  syncIfConfigured(reason) {
    if (!this.settings.autoSync && reason === 'interval') return;
    if (!this.getAuthStore().refresh_token) return;
    this.syncNow(false).catch(err => this.setStatus('同步失败：' + (err.message || err)));
  }

  scheduleSync() {
    if (this.syncTimer) window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = null;
      this.syncIfConfigured('vault-change');
    }, 2500);
  }

  setStatus(text) {
    if (this.statusItem) this.statusItem.setText('ELH · ' + text);
  }

  getTypeEnabled(type) {
    if (type === 'knowledge') return this.settings.syncKnowledge;
    if (type === 'record') return this.settings.syncRecords;
    if (type === 'resource') return this.settings.syncResources;
    return this.settings.syncCourses;
  }

  async readLocalItems() {
    const root = this.settings.rootFolder;
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(root + '/'));
    const items = new Map();
    const rawByKey = new Map();
    const duplicates = [];
    for (const file of files) {
      let raw = await this.app.vault.cachedRead(file);
      const parsed = parseFrontmatter(raw);
      if (!parsed.hasFrontmatter) continue;
      const item = buildItemFromFrontmatter(parsed.frontmatter, parsed.body);
      if (!item || !this.getTypeEnabled(item.type)) continue;
      if (!item.id) {
        if (['knowledge', 'record', 'resource', 'course'].includes(item.type) || (item.type === 'lesson' && item.courseId)) {
          item.id = makeId(item.type);
          raw = itemToMarkdown(item);
          // This is the exact source file currently being read. It is safe to
          // update it even though its old frontmatter did not yet contain elh_id.
          await this.writeMarkdown(file.path, raw, { allowExisting: true });
        } else continue;
      }
      if (item.type === 'resource' && !item.url) continue; // An empty resource template is a draft, not a sync failure.
      if (item.type === 'resource' && !normalizedHttpUrl(item.url)) throw new Error('请为资源「' + item.title + '」填写有效的 http:// 或 https:// 链接后再同步。');
      const key = itemKey(item.type, item.id);
      if (items.has(key)) { duplicates.push({ key, first: items.get(key).file, second: file }); continue; }
      items.set(key, { item, file, raw, frontmatter: parsed.frontmatter });
      rawByKey.set(key, raw);
    }
    return { items, rawByKey, duplicates };
  }

  async scanDuplicateSyncIds() {
    const root = normalizeRoot(this.settings.rootFolder);
    const files = this.app.vault.getMarkdownFiles().filter(file => file.path.startsWith(root + '/'));
    const grouped = new Map();
    for (const file of files) {
      const raw = await this.app.vault.cachedRead(file);
      const parsed = parseFrontmatter(raw);
      if (!parsed.hasFrontmatter) continue;
      const type = String(parsed.frontmatter.elh_type || '').toLowerCase();
      const id = String(parsed.frontmatter.elh_id || '').trim();
      if (!['knowledge', 'record', 'resource', 'course', 'lesson'].includes(type) || !id || !this.getTypeEnabled(type)) continue;
      // Match readLocalItems(): an empty resource template is a draft and does not
      // participate in synchronization or duplicate-ID blocking.
      if (type === 'resource' && !String(parsed.frontmatter.url || '').trim()) continue;
      const key = itemKey(type, id);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push({
        file,
        path: file.path,
        raw,
        hash: hash(raw),
        title: String(parsed.frontmatter.title || file.basename || file.name || file.path),
        type,
        id
      });
    }
    return Array.from(grouped.entries())
      .filter(([, entries]) => entries.length > 1)
      .map(([key, entries]) => {
        entries.sort((a, b) => a.path.localeCompare(b.path));
        return {
          key,
          files: entries,
          identical: entries.every(entry => entry.raw === entries[0].raw),
          uniqueHashes: new Set(entries.map(entry => entry.hash)).size
        };
      })
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  async openDuplicateDiagnostics() {
    try {
      const groups = await this.scanDuplicateSyncIds();
      if (!groups.length) {
        new Notice('没有发现重复的同步 ID。');
        return;
      }
      new DuplicateSyncIdModal(this.app, this, groups).open();
    } catch (error) {
      new Notice('扫描重复同步 ID 失败：' + (error.message || error));
    }
  }

  async archiveDuplicateGroup(key, keepPath) {
    const root = normalizeRoot(this.settings.rootFolder);
    const group = (await this.scanDuplicateSyncIds()).find(entry => entry.key === key);
    if (!group || group.files.length < 2) throw new Error('该重复 ID 已不存在或已被其他操作整理，请重新扫描。');
    if (!group.files.some(entry => entry.path === keepPath)) throw new Error('选择保留的笔记已不在当前重复组中，请重新扫描。');

    const rootParts = root.split('/');
    const rootName = rootParts.pop();
    const rootParent = rootParts.join('/');
    const backupRootName = rootName + ' - 重复ID备份';
    let backupRootRequested = normalizePath((rootParent ? rootParent + '/' : '') + backupRootName);
    // ensureFolder intentionally treats a file at the first path segment as a
    // hard error (the normal sync-root safety rule). For this auxiliary backup
    // directory, choose a free sibling name rather than failing or touching it.
    for (let suffix = 1; this.app.vault.getAbstractFileByPath(backupRootRequested) instanceof TFile; suffix++) {
      backupRootRequested = normalizePath((rootParent ? rootParent + '/' : '') + backupRootName + '-' + suffix);
      if (suffix > 100) throw new Error('无法找到安全的重复笔记备份目录，请先为备份目录名称腾出空间。');
    }
    const backupRoot = await this.ensureFolder(backupRootRequested);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const batchFolder = await this.ensureFolder(backupRoot + '/' + stamp + '-' + makeId('copy').slice(-8));
    const toMove = group.files.filter(entry => entry.path !== keepPath);
    const moved = [];

    this.applying = true;
    try {
      for (const entry of toMove) {
        // Re-validate identity immediately before moving. Never archive a file that
        // has been edited/replaced since the diagnostic view was opened.
        const current = this.app.vault.getAbstractFileByPath(entry.path);
        if (!(current instanceof TFile)) throw new Error('待备份文件已不存在或不再是 Markdown 文件：' + entry.path + '。请重新扫描。');
        const currentRaw = await this.app.vault.cachedRead(current);
        const parsed = parseFrontmatter(currentRaw);
        const currentKey = itemKey(String(parsed.frontmatter.elh_type || '').toLowerCase(), String(parsed.frontmatter.elh_id || '').trim());
        if (currentKey !== key) throw new Error('文件同步身份在整理前发生变化，已停止操作：' + entry.path);

        const relative = entry.path.slice(root.length + 1);
        const relativeParts = relative.split('/');
        const filename = relativeParts.pop();
        const relativeParent = relativeParts.join('/');
        const destinationParent = relativeParent
          ? await this.ensureFolder(batchFolder + '/' + relativeParent)
          : batchFolder;
        const ext = filename.toLowerCase().endsWith('.md') ? '.md' : '';
        const stem = ext ? filename.slice(0, -3) : filename;
        let destination = normalizePath(destinationParent + '/' + filename);
        for (let suffix = 1; this.app.vault.getAbstractFileByPath(destination); suffix++) {
          destination = normalizePath(destinationParent + '/' + stem + '--备份-' + suffix + ext);
          if (suffix > 100) throw new Error('备份目录中出现过多同名文件，已停止移动：' + entry.path);
        }

        if (this.app.fileManager && typeof this.app.fileManager.renameFile === 'function') {
          await this.app.fileManager.renameFile(current, destination);
        } else if (this.app.vault && typeof this.app.vault.rename === 'function') {
          await this.app.vault.rename(current, destination);
        } else {
          throw new Error('当前 Obsidian 环境不支持安全移动文件，未删除任何笔记。');
        }
        moved.push({ from: entry.path, to: destination });
      }

      // The manifest stores a content baseline and path hint. Update the hint to
      // the canonical file selected by the user; the content hash remains intact.
      const manifestItem = this.settings.manifest?.items?.[key];
      if (manifestItem) manifestItem.path = keepPath;
      await this.saveSettings();
      return { key, kept: keepPath, moved, backupFolder: batchFolder };
    } finally {
      this.applying = false;
    }
  }

  async ensureFolder(path) {
    const normalized = normalizePath(path);
    if (!normalized) return '';
    const parts = normalized.split('/').filter(Boolean);
    let current = '';
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index];
      let candidate = current ? current + '/' + part : part;
      let existing = this.app.vault.getAbstractFileByPath(candidate);
      if (existing instanceof TFolder) {
        current = candidate;
        continue;
      }
      if (existing instanceof TFile) {
        // A user file occupies a directory name expected by the plugin. Never
        // delete or replace it; use a deterministic sibling directory instead.
        if (index === 0) throw new Error('同步根目录与现有文件冲突：' + candidate + '。请将这个同名文件改名，或在插件设置中更换同步根目录。');
        const base = part + '--ELH';
        let resolved = '';
        for (let n = 1; n <= 50; n++) {
          const folderName = n === 1 ? base : base + '-' + n;
          const alternate = (current ? current + '/' : '') + folderName;
          const found = this.app.vault.getAbstractFileByPath(alternate);
          if (found instanceof TFolder) { resolved = alternate; break; }
          if (found) continue;
          try {
            await this.app.vault.createFolder(alternate);
            resolved = alternate;
            break;
          } catch (error) {
            const after = this.app.vault.getAbstractFileByPath(alternate);
            if (after instanceof TFolder) { resolved = alternate; break; }
            if (!after && !/already exists|已存在/i.test(String(error?.message || error))) throw error;
          }
        }
        if (!resolved) throw new Error('无法为同步目录创建安全的备用文件夹：' + candidate);
        current = resolved;
        continue;
      }
      try {
        await this.app.vault.createFolder(candidate);
        current = candidate;
      } catch (error) {
        const after = this.app.vault.getAbstractFileByPath(candidate);
        if (after instanceof TFolder) { current = candidate; continue; }
        if (after instanceof TFile) {
          if (index === 0) throw new Error('同步根目录与现有文件冲突：' + candidate + '。请将这个同名文件改名，或在插件设置中更换同步根目录。');
          const alternate = await this.ensureFolder((current ? current + '/' : '') + part + '--ELH');
          current = alternate;
          continue;
        }
        throw new Error('创建同步目录失败（' + candidate + '）：' + (error.message || error));
      }
    }
    return current;
  }

  async fileMatchesItem(file, item) {
    if (!(file instanceof TFile) || !item || !item.type || !item.id) return false;
    try {
      const parsed = parseFrontmatter(await this.app.vault.cachedRead(file));
      return String(parsed.frontmatter.elh_type || '') === String(item.type)
        && String(parsed.frontmatter.elh_id || '') === String(item.id);
    } catch (_) { return false; }
  }

  collisionFilePath(path, item, markdown, attempt) {
    const normalized = normalizePath(path);
    const slash = normalized.lastIndexOf('/');
    const parent = slash >= 0 ? normalized.slice(0, slash) : '';
    const filename = slash >= 0 ? normalized.slice(slash + 1) : normalized;
    const dot = filename.toLowerCase().endsWith('.md') ? filename.slice(0, -3) : filename;
    const suffixSource = item && item.type && item.id ? item.type + ':' + item.id : String(markdown || 'ELH');
    const identity = hash(suffixSource).split(':')[0].slice(0, 8);
    const suffix = '--elh-' + identity + (attempt > 1 ? '-' + attempt : '');
    return normalizePath((parent ? parent + '/' : '') + dot + suffix + '.md');
  }

  async writeMarkdown(path, markdown, options = {}) {
    const requestedPath = normalizePath(path);
    const originalPath = ensureVisibleMarkdownPath(requestedPath);
    const parentPath = originalPath.split('/').slice(0, -1).join('/');
    const actualParent = await this.ensureFolder(parentPath);
    const filename = originalPath.split('/').pop();
    const preferredPath = normalizePath((actualParent ? actualParent + '/' : '') + filename);
    const item = options.item || null;
    let candidate = preferredPath;
    this.applying = true;
    try {
      for (let attempt = 0; attempt <= 50; attempt++) {
        const existing = this.app.vault.getAbstractFileByPath(candidate);
        if (existing instanceof TFile) {
          const sameItem = options.allowExisting || await this.fileMatchesItem(existing, item);
          if (sameItem) {
            try {
              await this.app.vault.modify(existing, markdown);
              return existing;
            } catch (error) {
              throw new Error('更新笔记失败（' + candidate + '）：' + (error.message || error));
            }
          }
          // The path belongs to another item or an unrelated user file. Move
          // this write to a stable ID-suffixed path rather than overwriting it.
          candidate = this.collisionFilePath(preferredPath, item, markdown, Math.max(1, attempt + 1));
          continue;
        }
        if (existing instanceof TFolder) {
          candidate = this.collisionFilePath(preferredPath, item, markdown, Math.max(1, attempt + 1));
          continue;
        }
        try {
          return await this.app.vault.create(candidate, markdown);
        } catch (error) {
          // Obsidian may report an existing file if the adapter cache changed
          // between the existence check and create(). Re-check before retrying.
          const after = this.app.vault.getAbstractFileByPath(candidate);
          if (after instanceof TFile && (options.allowExisting || await this.fileMatchesItem(after, item))) {
            await this.app.vault.modify(after, markdown);
            return after;
          }
          if (after || /already exists|已存在/i.test(String(error?.message || error))) {
            candidate = this.collisionFilePath(preferredPath, item, markdown, Math.max(1, attempt + 1));
            continue;
          }
          throw new Error('创建笔记失败（' + candidate + '）：' + (error.message || error));
        }
      }
      throw new Error('目标路径存在多个文件/文件夹冲突，已停止写入以避免覆盖数据。原路径：' + preferredPath);
    } finally { this.applying = false; }
  }

  async trashFile(file) {
    if (!file) return;
    this.applying = true;
    try { await this.app.fileManager.trashFile(file); }
    finally { this.applying = false; }
  }

  async createConflictNote(key, localRaw, remoteRaw, revision, variant = '') {
    const [type, id] = key.split(':');
    const variantSuffix = variant ? '--' + safeSlug(variant) : '';
    const path = normalizePath(this.settings.rootFolder + '/_同步冲突/' + safeSlug(type + '-' + id) + variantSuffix + '--r' + revision + '.md');
    if (this.app.vault.getAbstractFileByPath(path)) return;
    const localBlock = localRaw === null ? '（本机文件已删除）' : '````markdown\n' + localRaw + '\n````';
    const remoteBlock = remoteRaw === null ? '（云端项目已删除）' : '````markdown\n' + remoteRaw + '\n````';
    const content = [
      '---', 'elh_conflict: true', 'elh_item_key: ' + yamlValue(key), 'elh_cloud_revision: ' + yamlValue(revision), '---', '',
      '# 同步冲突：' + type + ' / ' + id, '',
      '同一条内容在 Obsidian 与学习网站两端同时发生修改，插件没有自动覆盖其中任何一方。请比较下方两个版本，将需要保留的内容合并到原来的同步笔记，再运行「现在同步学习网站与 Obsidian」。', '',
      '## 本机版本', '', localBlock, '', '## 云端版本', '', remoteBlock, ''
    ].join('\n');
    await this.writeMarkdown(path, content);
  }

  async archiveLegacyDotFile(sourcePath, item) {
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.rename !== 'function' || typeof adapter.mkdir !== 'function' || typeof adapter.exists !== 'function') {
      throw new Error('当前 Obsidian 文件适配器不支持安全归档旧隐藏文件。原文件已保留，未删除。');
    }
    const root = normalizeRoot(this.settings.rootFolder);
    const parts = root.split('/');
    const rootName = parts.pop() || 'Embedded Learning Hub';
    const rootParent = parts.join('/');
    const backupBase = normalizePath((rootParent ? rootParent + '/' : '') + rootName + ' - 点号文件备份');

    let backupRoot = backupBase;
    for (let suffix = 1; await adapter.exists(backupRoot); suffix++) {
      backupRoot = backupBase + '-' + suffix;
      if (suffix > 50) throw new Error('无法为旧版隐藏笔记创建安全备份目录：' + backupBase);
    }
    await adapter.mkdir(backupRoot);

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const batchFolder = normalizePath(backupRoot + '/' + stamp + '-' + makeId('hidden').slice(-8));
    await adapter.mkdir(batchFolder);

    const suffix = String(item.id || 'item').replace(/[^A-Za-z0-9_-]/g, '').slice(-12) || 'item';
    const filename = '隐藏笔记-' + safeSlug(item.title || item.id) + '--' + suffix + '.md';
    const dot = filename.toLowerCase().endsWith('.md') ? filename.slice(0, -3) : filename;
    let destination = normalizePath(batchFolder + '/' + filename);
    for (let attempt = 1; await adapter.exists(destination); attempt++) {
      destination = normalizePath(batchFolder + '/' + dot + '-' + attempt + '.md');
      if (attempt > 100) throw new Error('备份目录中出现过多同名隐藏笔记：' + sourcePath);
    }
    await adapter.rename(sourcePath, destination);
    return destination;
  }

  async migrateLegacyDotFiles(cloudItems, revision, localItems = new Map()) {
    const adapter = this.app.vault.adapter;
    if (!adapter || typeof adapter.exists !== 'function' || typeof adapter.read !== 'function') return [];
    const results = [];
    for (const item of cloudItems.values()) {
      if (!item || !item.type || !item.id) continue;
      const legacyPath = legacyItemFilePath(this.settings.rootFolder, item);
      const visiblePath = itemFilePath(this.settings.rootFolder, item);
      const rootPrefix = normalizeRoot(this.settings.rootFolder) + '/';
      const legacyRelative = legacyPath.startsWith(rootPrefix) ? legacyPath.slice(rootPrefix.length) : legacyPath;
      const hasHiddenSegment = legacyRelative.split('/').some(segment => segment.startsWith('.'));
      if (legacyPath === visiblePath || !hasHiddenSegment) continue;

      let legacyExists = false;
      try { legacyExists = await adapter.exists(legacyPath); } catch (_) { legacyExists = false; }
      if (!legacyExists) continue;

      // The Vault API intentionally filters hidden dot-prefixed paths on some
      // platforms. DataAdapter is used only for this legacy-path migration.
      let legacyRaw;
      try { legacyRaw = await adapter.read(legacyPath); }
      catch (error) { throw new Error('检测到旧版点号隐藏笔记，但无法读取：' + legacyPath + '。请勿删除该文件；原始错误：' + (error.message || error)); }
      const parsed = parseFrontmatter(legacyRaw);
      const legacyType = String(parsed.frontmatter.elh_type || '').toLowerCase();
      const legacyId = String(parsed.frontmatter.elh_id || '').trim();
      if (legacyType !== item.type || legacyId !== String(item.id)) {
        // Same path but not the same ELH item: do not move or overwrite it.
        results.push({ path: legacyPath, status: 'unrelated' });
        continue;
      }

      this.applying = true;
      try {
        const key = itemKey(item.type, item.id);
        const localEntry = localItems && localItems.get(key);
        const current = localEntry?.file || this.app.vault.getAbstractFileByPath(visiblePath);
        if (current instanceof TFile && await this.fileMatchesItem(current, item)) {
          const currentRaw = localEntry?.raw ?? await this.app.vault.cachedRead(current);
          if (currentRaw !== legacyRaw) {
            await this.createConflictNote(key, legacyRaw, currentRaw, revision, '点号隐藏文件迁移');
          }
        } else if (!current) {
          const parentPath = visiblePath.split('/').slice(0, -1).join('/');
          await this.ensureFolder(parentPath);
          try {
            await this.app.vault.create(visiblePath, legacyRaw);
          } catch (error) {
            // A visible destination may have appeared between check and create.
            // Route through the normal identity-safe writer, which never replaces
            // an unrelated file or folder.
            await this.writeMarkdown(visiblePath, legacyRaw, { item });
          }
        } else {
          await this.writeMarkdown(visiblePath, legacyRaw, { item });
        }

        let backupPath = '';
        let status = 'migrated';
        try { backupPath = await this.archiveLegacyDotFile(legacyPath, item); }
        catch (error) {
          status = 'restored-unarchived';
          // A visible, indexed copy now exists. Keep the hidden original intact if
          // archiving is unavailable, and tell the user where to review it.
          new Notice('已恢复旧版隐藏笔记，但原隐藏文件暂未能移动到备份目录：' + legacyPath + '。原文件仍保留，原因：' + (error.message || error));
        }
        results.push({ path: legacyPath, visiblePath, backupPath, status });
      } finally {
        this.applying = false;
      }
    }
    return results;
  }

  async syncNow(showNotice = true) {
    if (this.syncing) return;
    if (!this.settings.supabaseUrl || !this.settings.publishableKey) {
      this.setStatus('请配置 Supabase');
      if (showNotice) new Notice('请先在 Obsidian 插件设置中填写 Supabase URL 和 publishable/anon key。');
      return;
    }
    if (!this.getAuthStore().refresh_token) {
      this.setStatus('未登录');
      if (showNotice) new Notice('请先在插件设置中使用学习网站的同一账号登录。');
      return;
    }
    this.syncing = true;
    this.setStatus('同步中…');
    try {
      const notifyDuplicateIds = async localSnapshot => {
        if (!localSnapshot.duplicates.length) return false;
        const groups = await this.scanDuplicateSyncIds();
        this.setStatus('发现重复 ID');
        if (showNotice && groups.length) new DuplicateSyncIdModal(this.app, this, groups).open();
        if (showNotice) new Notice('发现 ' + groups.length + ' 组重复同步 ID，已打开诊断面板。请检查文件路径并选择要保留的笔记；其他副本会移动到同步目录之外的备份文件夹，不会被删除。');
        return true;
      };
      const localBeforeMigration = await this.readLocalItems();
      if (await notifyDuplicateIds(localBeforeMigration)) return;
      // Preflight the cloud snapshot once so old dot-prefixed notes (hidden from
      // the Vault API) can be restored into visible paths before local comparison.
      const preflightRow = await this.fetchWorkspace();
      const preflightCloud = workspaceToItems(preflightRow.state || {});
      const legacyDotMigrations = await this.migrateLegacyDotFiles(preflightCloud, preflightRow.revision, localBeforeMigration.items);
      const local = await this.readLocalItems();
      if (await notifyDuplicateIds(local)) return;
      const previousRootFolder = this.settings.manifest.rootFolder || '';
      const rootFolderChanged = !!previousRootFolder && previousRootFolder !== this.settings.rootFolder;
      let finalRow = null;
      let operations = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        const row = await this.fetchWorkspace();
        const workspace = clone(row.state || {});
        const cloud = workspaceToItems(workspace);
        const manifest = rootFolderChanged ? {} : (this.settings.manifest.items || {});
        const cloudUpdates = [];
        const cloudDeletes = [];
        const fileWrites = [];
        const fileDeletes = [];
        const conflicts = [];
        const locallyDeletedCourseIds = new Set();
        const allKeys = new Set([...cloud.keys(), ...local.items.keys(), ...Object.keys(manifest)]);
        for (const key of allKeys) {
          const keyType = key.split(':', 1)[0];
          if (!this.getTypeEnabled(keyType)) continue;
          const remoteItem = cloud.get(key) || null;
          const localEntry = local.items.get(key) || null;
          const base = manifest[key] || null;
          const localRaw = localEntry ? localEntry.raw : null;
          const localItem = localEntry ? localEntry.item : null;
          const remoteRaw = remoteItem ? itemToMarkdown(remoteItem) : null;
          const localChanged = base ? (localRaw === null || hash(localRaw) !== base.fileHash) : !!localEntry;
          const remoteChanged = base ? (remoteRaw === null || hash(remoteRaw) !== base.fileHash) : !!remoteItem;
          if (!base) {
            if (localEntry && !remoteItem) cloudUpdates.push(localItem);
            else if (remoteItem && !localEntry) fileWrites.push({ key, item: remoteItem, markdown: remoteRaw, path: itemFilePath(this.settings.rootFolder, remoteItem) });
            else if (localEntry && remoteItem && hash(localRaw) !== hash(remoteRaw)) conflicts.push({ key, localRaw, remoteRaw, localPath: localEntry.file.path, revision: row.revision });
            continue;
          }
          if (remoteItem && localEntry) {
            if (!localChanged && !remoteChanged) continue;
            if (localChanged && !remoteChanged) cloudUpdates.push(localItem);
            else if (!localChanged && remoteChanged) fileWrites.push({ key, item: remoteItem, markdown: remoteRaw, path: localEntry.file.path });
            else if (hash(localRaw) !== hash(remoteRaw)) conflicts.push({ key, localRaw, remoteRaw, localPath: localEntry.file.path, revision: row.revision });
          } else if (remoteItem && !localEntry) {
            if (!remoteChanged) {
              cloudDeletes.push({ type: remoteItem.type, id: remoteItem.id, courseId: remoteItem.courseId });
              if (remoteItem.type === 'course') locallyDeletedCourseIds.add(remoteItem.id);
            } else {
              conflicts.push({ key, localRaw: null, remoteRaw, localPath: '', revision: row.revision });
              fileWrites.push({ key, item: remoteItem, markdown: remoteRaw, path: itemFilePath(this.settings.rootFolder, remoteItem) });
            }
          } else if (!remoteItem && localEntry) {
            if (localChanged) conflicts.push({ key, localRaw, remoteRaw: null, localPath: localEntry.file.path, revision: row.revision });
            fileDeletes.push({ key, file: localEntry.file });
          }
        }
        // Removing a course note means removing the course from the website as well.
        // Its lesson notes must be archived alongside it; otherwise they would become
        // orphaned and be re-imported on the next pass. Preserve edited lesson text in
        // conflict recovery notes before trashing those child files.
        if (locallyDeletedCourseIds.size) {
          for (const [lessonKey, lessonItem] of cloud.entries()) {
            if (lessonItem.type !== 'lesson' || !locallyDeletedCourseIds.has(lessonItem.courseId)) continue;
            const lessonEntry = local.items.get(lessonKey);
            if (!lessonEntry) continue;
            const lessonBase = manifest[lessonKey] || null;
            const lessonChanged = lessonBase ? hash(lessonEntry.raw) !== lessonBase.fileHash : true;
            if (lessonChanged) conflicts.push({ key: lessonKey, localRaw: lessonEntry.raw, remoteRaw: itemToMarkdown(lessonItem), localPath: lessonEntry.file.path, revision: row.revision });
            fileDeletes.push({ key: lessonKey, file: lessonEntry.file });
          }
        }
        let changedState = false;
        for (const item of cloudUpdates) { upsertWorkspaceItem(workspace, item); changedState = true; }
        for (const item of cloudDeletes) { removeWorkspaceItem(workspace, item); changedState = true; }
        if (changedState) {
          const updated = await this.compareAndSwapWorkspace(row, workspace);
          if (!updated) continue;
          finalRow = updated;
        } else finalRow = row;
        operations = { local, fileWrites, fileDeletes, conflicts, cloudUpdates, cloudDeletes, legacyDotMigrations };
        break;
      }
      if (!finalRow || !operations) throw new Error('云端数据在同步期间连续发生变化，已停止本轮写入以避免覆盖。请再次执行同步。');

      // Refresh local files from the committed cloud snapshot. Conflicting local text is
      // first copied to a separate recovery note, then the canonical file follows cloud.
      const finalCloud = workspaceToItems(finalRow.state || {});
      for (const conflict of operations.conflicts) {
        const remoteItem = finalCloud.get(conflict.key) || null;
        const remoteRaw = remoteItem ? itemToMarkdown(remoteItem) : (conflict.remoteRaw !== undefined ? conflict.remoteRaw : null);
        await this.createConflictNote(conflict.key, conflict.localRaw, remoteRaw, finalRow.revision);
      }
      for (const deletion of operations.fileDeletes) {
        const current = this.app.vault.getAbstractFileByPath(deletion.file.path);
        if (current instanceof TFile) await this.trashFile(current);
      }
      for (const write of operations.fileWrites) {
        const item = finalCloud.get(write.key) || write.item;
        const markdown = itemToMarkdown(item);
        await this.writeMarkdown(write.path, markdown, { item });
      }
      // Ensure all remote-only items have a local Markdown file, including first sync.
      const currentAfterWrites = await this.readLocalItems();
      for (const [key, item] of finalCloud.entries()) {
        if (!this.getTypeEnabled(item.type) || currentAfterWrites.items.has(key)) continue;
        const path = itemFilePath(this.settings.rootFolder, item);
        await this.writeMarkdown(path, itemToMarkdown(item), { item });
      }
      // New local items now have IDs and canonical metadata written back to their source files.
      const localAfter = await this.readLocalItems();
      const nextManifest = {};
      const oldManifest = this.settings.manifest.items || {};
      for (const [key, value] of Object.entries(oldManifest)) { if (!rootFolderChanged && !this.getTypeEnabled(key.split(':', 1)[0])) nextManifest[key] = value; }
      for (const [key, item] of finalCloud.entries()) {
        if (!this.getTypeEnabled(item.type)) continue;
        const localEntry = localAfter.items.get(key);
        const markdown = itemToMarkdown(item);
        if (!localEntry) continue;
        nextManifest[key] = { type: item.type, id: item.id, path: localEntry.file.path, fileHash: hash(markdown), revision: finalRow.revision };
        // If canonical metadata differs after a local edit (for example updated_at),
        // rewrite in-place so the next comparison starts from an exact shared baseline.
        if (hash(localEntry.raw) !== hash(markdown)) await this.writeMarkdown(localEntry.file.path, markdown, { item });
      }
      this.settings.manifest = { items: nextManifest, rootFolder: this.settings.rootFolder, lastRevision: finalRow.revision, lastSyncedAt: new Date().toISOString() };
      await this.saveSettings();
      const changedCount = operations.cloudUpdates.length + operations.cloudDeletes.length;
      const conflictCount = operations.conflicts.length;
      this.setStatus(conflictCount ? '有 ' + conflictCount + ' 项待合并' : '已同步 · r' + finalRow.revision);
      if (showNotice || changedCount || conflictCount) {
        const migrationResults = operations.legacyDotMigrations || [];
        const migratedCount = migrationResults.filter(x => x.status === 'migrated').length;
        const unarchivedCount = migrationResults.filter(x => x.status === 'restored-unarchived').length;
        const migrationSuffix = (migratedCount ? ' 另外已恢复 ' + migratedCount + ' 篇旧版点号隐藏笔记，原文件已移至「点号文件备份」目录。' : '')
          + (unarchivedCount ? ' 另有 ' + unarchivedCount + ' 篇隐藏原文件未能归档，仍保留在原位置，请检查前面的提示。' : '');
        new Notice((conflictCount
          ? '同步完成，但有 ' + conflictCount + ' 项发生双端冲突。已生成冲突副本，请检查「_同步冲突」文件夹。'
          : '学习网站与 Obsidian 已同步。') + migrationSuffix);
      }
    } catch (error) {
      this.setStatus('同步失败');
      if (showNotice) new Notice('嵌入式学习站同步失败：' + (error.message || error));
      throw error;
    } finally {
      this.syncing = false;
    }
  }

  async chooseCourseForNewLesson() {
    try {
      const row = await this.fetchWorkspace();
      const courses = Array.from(workspaceToItems(row.state || {}).values()).filter(item => item.type === 'course');
      if (!courses.length) throw new Error('云端没有可用课程。请先在学习网站创建课程并完成一次云同步。');
      new CoursePickerModal(this.app, courses, course => {
        this.createTemplateNote('lesson', course).catch(error => new Notice('创建课时笔记失败：' + (error.message || error)));
      }).open();
    } catch (error) { new Notice('无法读取课程列表：' + (error.message || error)); }
  }

  async createTemplateNote(type, course = null) {
    const names = { knowledge: '新知识卡片', record: '新学习记录', resource: '新资源收藏', course: '新建课程', lesson: '新课时笔记' };
    if (!names[type]) throw new Error('不支持的笔记类型：' + type);
    if (type === 'lesson' && (!course || !course.id)) throw new Error('新建课时笔记时必须先选择所属课程。');
    const id = makeId(type);
    const date = new Date().toISOString().slice(0, 10);
    const fields = [
      '---',
      'elh_type: ' + yamlValue(type),
      'elh_id: ' + yamlValue(id),
      'title: ' + yamlValue(names[type])
    ];
    if (type === 'knowledge' || type === 'record' || type === 'resource') fields.push('category: ' + yamlValue('自定义'));
    if (type === 'record') fields.push('date: ' + yamlValue(date), 'minutes: 30', 'next: ""');
    if (type === 'resource') fields.push('url: ""', 'tag: ' + yamlValue('MY RESOURCE'));
    if (type === 'course') fields.push('category: ' + yamlValue('自定义'), 'level: ' + yamlValue('入门'), 'duration: ' + yamlValue('待填写'), 'desc: ""', 'color: ' + yamlValue('mint'), 'icon: ' + yamlValue('book'), 'code: ' + yamlValue('OBSIDIAN'), 'stages: []');
    if (type === 'lesson') fields.push('course_id: ' + yamlValue(course.id), 'stage: ' + yamlValue('补充与拓展'), 'minutes: 20', 'summary: ""', 'takeaways: []', 'exercise: ""', 'exercise_answer: ""', 'reference: ""', 'completed: false');
    fields.push('---', '', '# ' + names[type], '');
    const markdown = fields.join('\n');
    const path = itemFilePath(this.settings.rootFolder, { type, id, title: names[type], courseId: course?.id || '', courseTitle: course?.title || '' });
    const file = await this.writeMarkdown(path, markdown, { item: { type, id } });
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice('已新建同步笔记。填写必要字段后会自动同步到学习网站。');
  }

}

class ConfirmDuplicateArchiveModal extends Modal {
  constructor(app, plugin, group, keepPath, onArchived) {
    super(app);
    this.plugin = plugin;
    this.group = group;
    this.keepPath = keepPath;
    this.onArchived = onArchived;
  }
  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: '确认整理重复同步 ID' });
    const different = !this.group.identical;
    contentEl.createEl('p', { text: different
      ? '这组笔记内容存在差异。将保留你选定的活动笔记，其余文件会原样移动到同步根目录之外的备份文件夹。不会合并、覆盖或删除内容。'
      : '这组笔记内容完全一致。将保留你选定的一份，其余文件会原样移动到同步根目录之外的备份文件夹。不会删除内容。' });
    contentEl.createEl('p', { text: '保留：' + this.keepPath });
    const actions = contentEl.createDiv({ cls: 'elh-duplicate-actions' });
    const cancel = actions.createEl('button', { text: '取消' });
    cancel.addEventListener('click', () => this.close());
    const confirm = actions.createEl('button', { text: '确认移动到备份', cls: 'mod-warning' });
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      try {
        const result = await this.plugin.archiveDuplicateGroup(this.group.key, this.keepPath);
        this.close();
        new Notice('已整理「' + result.key + '」：保留 1 篇，备份 ' + result.moved.length + ' 篇。备份位置：' + result.backupFolder);
        await this.onArchived();
      } catch (error) {
        confirm.disabled = false;
        new Notice('整理重复笔记失败：' + (error.message || error));
      }
    });
  }
  onClose() { this.contentEl.empty(); }
}

class DuplicateSyncIdModal extends Modal {
  constructor(app, plugin, groups) {
    super(app);
    this.plugin = plugin;
    this.groups = groups || [];
  }
  onOpen() { this.render(); }
  async refreshGroups() {
    this.groups = await this.plugin.scanDuplicateSyncIds();
    this.render();
  }
  render() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('elh-duplicate-modal');
    contentEl.createEl('h2', { text: '重复同步 ID 诊断' });
    contentEl.createEl('p', { text: '这里只检查当前启用的同步类型。整理时，未选中的笔记会移动到同步根目录之外的备份文件夹，内容不会被删除，也不会再参与同步。' });
    if (!this.groups.length) {
      contentEl.createEl('p', { text: '没有发现重复同步 ID。可以关闭此窗口并重新执行「现在同步」。', cls: 'elh-duplicate-empty' });
      return;
    }
    contentEl.createEl('p', { text: '共发现 ' + this.groups.length + ' 组重复 ID。请逐组选择要保留的活动笔记。' });
    for (const group of this.groups) {
      const card = contentEl.createDiv({ cls: 'elh-duplicate-card' });
      card.createEl('h3', { text: group.key });
      const identicalText = group.identical
        ? '这些文件的 Markdown 内容逐字节一致。'
        : '这些文件内容存在差异。请先查看各版本预览，再选择要保留的版本。';
      card.createEl('p', { text: group.files.length + ' 个文件 · ' + identicalText, cls: group.identical ? 'elh-duplicate-identical' : 'elh-duplicate-different' });

      const selectLabel = card.createEl('label', { text: '保留为正式同步笔记：' });
      const select = card.createEl('select', { cls: 'elh-duplicate-select' });
      for (const entry of group.files) {
        const option = select.createEl('option', { text: entry.path + ' · ' + entry.title });
        option.value = entry.path;
      }
      select.value = group.files[0].path;

      const list = card.createDiv({ cls: 'elh-duplicate-file-list' });
      for (const entry of group.files) {
        const row = list.createDiv({ cls: 'elh-duplicate-file-row' });
        row.createEl('code', { text: entry.path });
        const open = row.createEl('button', { text: '打开' });
        open.addEventListener('click', async () => {
          const current = this.app.vault.getAbstractFileByPath(entry.path);
          if (current instanceof TFile) await this.app.workspace.getLeaf(false).openFile(current);
          else new Notice('文件已不存在，请重新扫描。');
        });
      }

      const details = card.createEl('details', { cls: 'elh-duplicate-previews' });
      details.createEl('summary', { text: '展开各版本内容预览' });
      for (const [index, entry] of group.files.entries()) {
        details.createEl('h4', { text: (index + 1) + '. ' + entry.path });
        const preview = entry.raw.length > 1800 ? entry.raw.slice(0, 1800) + '\n\n……（预览已截断，原文件不会改变）' : entry.raw;
        details.createEl('pre', { text: preview });
      }

      const actions = card.createDiv({ cls: 'elh-duplicate-actions' });
      const archive = actions.createEl('button', { text: group.identical ? '保留所选，安全归档其余副本' : '保留所选版本，备份其余笔记', cls: 'mod-cta' });
      archive.addEventListener('click', () => {
        const keepPath = select.value;
        new ConfirmDuplicateArchiveModal(this.app, this.plugin, group, keepPath, () => this.refreshGroups()).open();
      });
    }
  }
  onClose() { this.contentEl.empty(); }
}

class EmbeddedLearningHubSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Embedded Learning Hub 双向同步' });
    containerEl.createEl('p', { text: '连接学习网站现有的 Supabase 工作区。电脑与手机端分别使用同一账号登录；令牌保存在本设备本地存储中。' });
    new Setting(containerEl).setName('Supabase Project URL').setDesc('与学习网站「偏好与数据 → 云同步」中使用的地址一致。').addText(text => text.setPlaceholder('https://xxxx.supabase.co').setValue(this.plugin.settings.supabaseUrl).onChange(async value => { this.plugin.settings.supabaseUrl = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('Publishable / anon key').setDesc('只能填写公开 publishable/anon key；不要使用 service_role 或 secret key。').addText(text => text.setPlaceholder('sb_publishable_... 或旧版 anon key').setValue(this.plugin.settings.publishableKey).onChange(async value => { this.plugin.settings.publishableKey = value.trim(); await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('学习网站账号').setDesc('使用现有学习网站账号，不需要重新注册。').addText(text => text.setPlaceholder('name@example.com').setValue(this.plugin.settings.email).onChange(async value => { this.plugin.settings.email = value.trim(); await this.plugin.saveSettings(); }));
    let passwordInput;
    new Setting(containerEl).setName('账号密码').setDesc('只用于登录，不会保存密码；登录后仅保存 Supabase 刷新令牌在本设备本地存储中。').addText(text => { passwordInput = text; text.inputEl.type = 'password'; text.setPlaceholder('学习网站账号密码'); });
    new Setting(containerEl).addButton(button => button.setButtonText('登录并立即同步').setCta().onClick(async () => {
      button.setDisabled(true); button.setButtonText('正在登录…');
      try { await this.plugin.login(this.plugin.settings.email, passwordInput.getValue()); passwordInput.setValue(''); }
      catch (error) { new Notice('登录失败：' + (error.message || error)); }
      finally { button.setDisabled(false); button.setButtonText('登录并立即同步'); }
    }));
    const session = this.plugin.getAuthStore();
    if (session.refresh_token) {
      new Setting(containerEl).setName('当前会话').setDesc('已登录。会话令牌保存在当前设备，不会要求 Vault 公开。').addButton(button => button.setButtonText('退出账号').setWarning().onClick(() => { this.plugin.clearAuthStore(); this.plugin.setStatus('未登录'); new Notice('已退出 Obsidian 同步账号。'); this.display(); }));
    }
    new Setting(containerEl).setName('同步根目录').setDesc('插件只管理这个目录内带有 elh_type 属性的 Markdown 笔记。').addText(text => text.setValue(this.plugin.settings.rootFolder).onChange(async value => { this.plugin.settings.rootFolder = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('自动同步').setDesc('启动、文件修改、网络恢复和应用回到前台时触发；手机进入后台时不依赖后台常驻。').addToggle(toggle => toggle.setValue(this.plugin.settings.autoSync).onChange(async value => { this.plugin.settings.autoSync = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('轮询间隔（秒）').setDesc('应用处于前台时的云端检查间隔，范围 30–900 秒。').addText(text => text.setValue(String(this.plugin.settings.intervalSeconds)).onChange(async value => { this.plugin.settings.intervalSeconds = Math.max(30, Math.min(900, Number(value) || 90)); await this.plugin.saveSettings(); }));
    containerEl.createEl('h3', { text: '同步范围' });
    new Setting(containerEl).setName('知识库').addToggle(toggle => toggle.setValue(this.plugin.settings.syncKnowledge).onChange(async value => { this.plugin.settings.syncKnowledge = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('学习记录').addToggle(toggle => toggle.setValue(this.plugin.settings.syncRecords).onChange(async value => { this.plugin.settings.syncRecords = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('课程笔记与学习进度').addToggle(toggle => toggle.setValue(this.plugin.settings.syncCourses).onChange(async value => { this.plugin.settings.syncCourses = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('资源收藏').addToggle(toggle => toggle.setValue(this.plugin.settings.syncResources).onChange(async value => { this.plugin.settings.syncResources = value; await this.plugin.saveSettings(); }));
    new Setting(containerEl).setName('执行同步').setDesc('立即检查网站与当前 Vault 的差异，按稳定 ID 合并；同一条内容双端同时编辑时生成冲突副本，不静默覆盖。').addButton(button => button.setButtonText('现在同步').setCta().onClick(() => this.plugin.syncNow(true)));
    new Setting(containerEl).setName('重复同步 ID 检查').setDesc('扫描同步目录中的重复身份，显示全部文件路径和内容差异；可将未选中的副本移动到同步目录之外的备份文件夹。').addButton(button => button.setButtonText('扫描并整理').onClick(() => this.plugin.openDuplicateDiagnostics()));
    containerEl.createEl('p', { text: '首次连接前，请先部署学习网站 V19 或更高版本、登录并完成至少一次云同步，以便将内置课程目录写入云端。首次 Obsidian 同步会根据云端内容创建 Markdown 笔记。' });
  }
}

module.exports = EmbeddedLearningHubSyncPlugin;
