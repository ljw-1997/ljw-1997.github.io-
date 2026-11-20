const obsidian = require('obsidian');
const Plugin = obsidian.Plugin;
const Notice = obsidian.Notice;
const PluginSettingTab = obsidian.PluginSettingTab;
const FuzzySuggestModal = obsidian.FuzzySuggestModal;
const Setting = obsidian.Setting;
const requestUrl = obsidian.requestUrl;
const normalizePath = obsidian.normalizePath;
const TFile = obsidian.TFile;

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
function safeSlug(value) {
  const slug = String(value || '未命名').normalize('NFKC').replace(/[\\/:*?"<>|]/g, '-').replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 72);
  return slug || '未命名';
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
function itemFilePath(root, item) {
  const typeFolder = { knowledge: '知识库', record: '学习记录', resource: '资源', course: '课程笔记', lesson: '课程笔记' }[item.type] || '其他';
  const suffix = String(item.id || 'new').replace(/[^A-Za-z0-9_-]/g, '').slice(-10) || 'new';
  if (item.type === 'lesson') { const courseSuffix = String(item.courseId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(-10) || 'course'; return normalizePath(root + '/' + typeFolder + '/' + safeSlug(item.courseTitle || item.courseId || '未分类课程') + '--' + courseSuffix + '/' + safeSlug(item.title) + '--' + suffix + '.md'); }
  if (item.type === 'course') return normalizePath(root + '/' + typeFolder + '/' + safeSlug(item.title) + '--' + suffix + '/课程.md');
  return normalizePath(root + '/' + typeFolder + '/' + safeSlug(item.title) + '--' + suffix + '.md');
}
function workspaceToItems(state) {
  const items = new Map();
  for (const note of state.notes || []) if (note && note.id) items.set(itemKey('knowledge', note.id), itemFromWorkspace('knowledge', note));
  for (const record of state.records || []) if (record && record.id) items.set(itemKey('record', record.id), itemFromWorkspace('record', record));
  for (const resource of state.resources || []) if (resource && resource.id) items.set(itemKey('resource', resource.id), itemFromWorkspace('resource', resource));
  const courses = state.obsidianCatalog && Array.isArray(state.obsidianCatalog.courses) ? state.obsidianCatalog.courses : null;
  if (!courses) throw new Error('云端工作区尚未包含 Obsidian 课程索引。请先将学习网站更新到 V19，登录并等待一次云同步完成，再连接 Obsidian。');
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
          await this.writeMarkdown(file.path, raw);
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

  async ensureFolder(path) {
    const normalized = normalizePath(path);
    const parts = normalized.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? current + '/' + part : part;
      if (!this.app.vault.getAbstractFileByPath(current)) await this.app.vault.createFolder(current);
    }
  }

  async writeMarkdown(path, markdown) {
    await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
    const existing = this.app.vault.getAbstractFileByPath(path);
    this.applying = true;
    try {
      if (existing instanceof TFile) await this.app.vault.modify(existing, markdown);
      else await this.app.vault.create(path, markdown);
    } finally { this.applying = false; }
  }

  async trashFile(file) {
    if (!file) return;
    this.applying = true;
    try { await this.app.fileManager.trashFile(file); }
    finally { this.applying = false; }
  }

  async createConflictNote(key, localRaw, remoteRaw, revision) {
    const [type, id] = key.split(':');
    const path = normalizePath(this.settings.rootFolder + '/_同步冲突/' + safeSlug(type + '-' + id) + '--r' + revision + '.md');
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
      const local = await this.readLocalItems();
      if (local.duplicates.length) throw new Error('发现重复的同步 ID：' + local.duplicates.map(x => x.key).join('、') + '。请先整理重复笔记。');
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
        operations = { local, fileWrites, fileDeletes, conflicts, cloudUpdates, cloudDeletes };
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
        await this.writeMarkdown(write.path, markdown);
      }
      // Ensure all remote-only items have a local Markdown file, including first sync.
      const currentAfterWrites = await this.readLocalItems();
      for (const [key, item] of finalCloud.entries()) {
        if (!this.getTypeEnabled(item.type) || currentAfterWrites.items.has(key)) continue;
        const path = itemFilePath(this.settings.rootFolder, item);
        await this.writeMarkdown(path, itemToMarkdown(item));
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
        if (hash(localEntry.raw) !== hash(markdown)) await this.writeMarkdown(localEntry.file.path, markdown);
      }
      this.settings.manifest = { items: nextManifest, rootFolder: this.settings.rootFolder, lastRevision: finalRow.revision, lastSyncedAt: new Date().toISOString() };
      await this.saveSettings();
      const changedCount = operations.cloudUpdates.length + operations.cloudDeletes.length;
      const conflictCount = operations.conflicts.length;
      this.setStatus(conflictCount ? '有 ' + conflictCount + ' 项待合并' : '已同步 · r' + finalRow.revision);
      if (showNotice || changedCount || conflictCount) {
        new Notice(conflictCount
          ? '同步完成，但有 ' + conflictCount + ' 项发生双端冲突。已生成冲突副本，请检查「_同步冲突」文件夹。'
          : '学习网站与 Obsidian 已同步。');
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
    await this.ensureFolder(path.split('/').slice(0, -1).join('/'));
    const file = await this.app.vault.create(path, markdown);
    await this.app.workspace.getLeaf(false).openFile(file);
    new Notice('已新建同步笔记。填写必要字段后会自动同步到学习网站。');
  }

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
    containerEl.createEl('p', { text: '首次连接前，请先部署学习网站 V19、登录并完成至少一次云同步，以便将内置课程目录写入云端。首次 Obsidian 同步会根据云端内容创建 Markdown 笔记。' });
  }
}

module.exports = EmbeddedLearningHubSyncPlugin;
