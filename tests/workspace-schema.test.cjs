const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../workspace-schema.js');

function validWorkspace(overrides = {}) {
  return {
    version: 3,
    profileName: '学习者',
    completedLessons: ['lesson-1'],
    records: [{ id: 'record-1', title: '学习 GPIO', date: '2026-11-23', minutes: 35, category: 'GPIO' }],
    resources: [{ id: 'resource-1', title: 'Arm 文档', url: 'https://developer.arm.com/' }],
    notes: [{ id: 'note-1', title: '中断笔记', content: '<p>...</p>' }],
    importedKnowledgeSets: [],
    customCourses: [{ id: 'course-1', title: '自定义课程', lessons: [{ id: 'lesson-1a', title: '第一课', minutes: 20 }] }],
    courseEdits: {},
    lessonEdits: {},
    stageEdits: {},
    addedLessons: { 'course-1': [{ id: 'lesson-2a', title: '第二课' }] },
    deletedCourseIds: [],
    deletedLessonIds: [],
    ...overrides,
  };
}

test('accepts a structurally valid workspace', () => {
  assert.deepEqual(schema.validate(validWorkspace()), []);
});

test('accepts legacy workspaces when newer optional fields are absent', () => {
  const legacy = { records: [], resources: [], notes: [], completedLessons: [] };
  assert.deepEqual(schema.validate(legacy), []);
});

test('rejects invalid record dates and non-finite durations', () => {
  const issues = schema.validate(validWorkspace({
    records: [{ id: 'r1', title: 'bad record', date: '23/11/2026', minutes: Infinity }],
  }));
  assert.ok(issues.some(message => message.includes('records[0].date')));
  assert.ok(issues.some(message => message.includes('records[0].minutes')));
});

test('rejects calendar-invalid dates even when their format looks correct', () => {
  const issues = schema.validate(validWorkspace({
    records: [{ id: 'r1', title: 'bad calendar date', date: '2026-02-31', minutes: 20 }],
  }));
  assert.ok(issues.some(message => message.includes('records[0].date')));
});

test('rejects non-HTTP resource URLs', () => {
  const issues = schema.validate(validWorkspace({
    resources: [{ id: 'resource-1', title: 'unsafe', url: 'javascript:alert(1)' }],
  }));
  assert.ok(issues.some(message => message.includes('resources[0].url')));
});

test('rejects duplicate IDs within a collection', () => {
  const issues = schema.validate(validWorkspace({
    notes: [
      { id: 'duplicate', title: 'one' },
      { id: 'duplicate', title: 'two' },
    ],
  }));
  assert.ok(issues.some(message => message.includes('notes[1].id')));
});

test('rejects malformed nested lesson data and edit maps', () => {
  const issues = schema.validate(validWorkspace({
    customCourses: [{ id: 'course-1', title: 'bad course', lessons: [{ id: '', title: '' }] }],
    lessonEdits: { 'lesson-1': 'not-an-object' },
  }));
  assert.ok(issues.some(message => message.includes('customCourses[0].lessons[0].id')));
  assert.ok(issues.some(message => message.includes('lessonEdits.lesson-1')));
});

test('rejects invalid workspace collection types', () => {
  const issues = schema.validate(validWorkspace({ notes: {} }));
  assert.ok(issues.some(message => message.includes('notes')));
});

test('rejects empty objects masquerading as workspaces', () => {
  assert.ok(schema.validate({}).some(message => message.includes('workspace')));
});

test('unwraps valid backup envelopes and rejects an invalid state payload', () => {
  const payload = validWorkspace();
  assert.deepEqual(schema.unwrapBackup({ app: 'embedded-learning-hub', version: 3, state: payload }), payload);
  assert.throws(() => schema.unwrapBackup({ app: 'embedded-learning-hub', version: 3, state: [] }), /state/);
});
