const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const schema = require('../workspace-schema.js');

const appSource = fs.readFileSync(require.resolve('../app.js'), 'utf8');
const loadStart = appSource.indexOf('function loadState(){');
const loadEnd = appSource.indexOf('\nlet state=loadState();', loadStart);
assert.ok(loadStart >= 0 && loadEnd > loadStart, 'loadState source must remain discoverable');
const loadStateSource = appSource.slice(loadStart, loadEnd);

function runLoadState(raw, shouldThrowOnRead = false) {
  const workspaceRecovery = { active: false, raw: null, reason: '', originalExported: false };
  const context = {
    STORAGE_KEY: 'embedded-lab-workspace-v1',
    workspaceRecovery,
    JSON,
    String,
    isPlainObject: schema.isPlainObject,
    defaultState: () => ({ version: 3, records: [], resources: [], notes: [] }),
    normalizeWorkspaceState(candidate, strict) {
      const copy = JSON.parse(JSON.stringify(candidate));
      if (strict) {
        const errors = schema.validate(copy);
        if (errors.length) throw new Error(errors.slice(0, 5).join('; '));
      }
      return copy;
    },
    localStorage: {
      getItem() {
        if (shouldThrowOnRead) throw new Error('storage denied');
        return raw;
      },
    },
  };
  vm.createContext(context);
  vm.runInContext(loadStateSource, context);
  return { state: context.loadState(), recovery: context.workspaceRecovery };
}

test('valid local workspace loads without entering recovery mode', () => {
  const raw = JSON.stringify({ version: 3, records: [], resources: [], notes: [] });
  const result = runLoadState(raw);
  assert.equal(result.recovery.active, false);
  assert.deepEqual(result.state.records, []);
});

test('malformed JSON is preserved verbatim and enters recovery mode', () => {
  const raw = '{"records": [broken json';
  const result = runLoadState(raw);
  assert.equal(result.recovery.active, true);
  assert.equal(result.recovery.raw, raw);
  assert.match(result.recovery.reason, /JSON|Unexpected|property/i);
});

test('schema-invalid JSON is preserved and enters recovery mode', () => {
  const raw = JSON.stringify({ version: 3, records: [{ id: 'r1', title: 'bad', date: 'not-a-date' }] });
  const result = runLoadState(raw);
  assert.equal(result.recovery.active, true);
  assert.equal(result.recovery.raw, raw);
  assert.match(result.recovery.reason, /records\[0\]\.date/);
});

test('storage read failures enter recovery mode without inventing a source backup', () => {
  const result = runLoadState(null, true);
  assert.equal(result.recovery.active, true);
  assert.equal(result.recovery.raw, null);
  assert.match(result.recovery.reason, /storage denied/);
});
