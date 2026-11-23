/* Runtime workspace schema validation shared by the browser app and Node tests. */
(function (root) {
  'use strict';

  function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  function validateWorkspace(candidate) {
    const errors = [];
    const issue = (path, message) => errors.push(`${path}: ${message}`);
    const isString = value => typeof value === 'string';
    const isFiniteNumber = value => typeof value === 'number' && Number.isFinite(value);
    const validDate = value => { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false; const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value; };

    if (!isPlainObject(candidate)) return ['工作区必须是普通 JSON 对象。'];

    const workspaceMarkers = ['completedLessons', 'records', 'resources', 'notes', 'customCourses', 'courseEdits', 'lessonEdits', 'stageEdits', 'addedLessons', 'deletedCourseIds', 'deletedLessonIds'];
    if (!workspaceMarkers.some(key => Object.prototype.hasOwnProperty.call(candidate, key))) {
      issue('workspace', '缺少工作区核心数据字段；拒绝将空对象当作有效备份。');
    }

    if (candidate.version !== undefined && (!Number.isInteger(candidate.version) || candidate.version < 1)) {
      issue('version', '必须是大于等于 1 的整数。');
    }
    for (const key of ['profileName', 'courseFilter', 'resourceFilter']) {
      if (candidate[key] !== undefined && !isString(candidate[key])) issue(key, '必须是字符串。');
    }

    const stringArrays = ['completedLessons', 'importedKnowledgeSets', 'deletedCourseIds', 'deletedLessonIds'];
    for (const key of stringArrays) {
      if (candidate[key] === undefined) continue;
      if (!Array.isArray(candidate[key]) || candidate[key].some(value => !isString(value) || !value.trim())) {
        issue(key, '必须是非空字符串组成的数组。');
      }
    }

    function validateArray(key, validator) {
      const value = candidate[key];
      if (value === undefined) return;
      if (!Array.isArray(value)) {
        issue(key, '必须是数组。');
        return;
      }
      const seen = new Set();
      value.forEach((item, index) => {
        const path = `${key}[${index}]`;
        if (!isPlainObject(item)) {
          issue(path, '必须是对象。');
          return;
        }
        if (typeof item.id === 'string') {
          if (seen.has(item.id)) issue(`${path}.id`, '同一集合中不能重复。');
          seen.add(item.id);
        }
        validator(item, path);
      });
    }

    const requiredString = (item, key, path, maxLength = 1000) => {
      if (!isString(item[key]) || !item[key].trim()) issue(`${path}.${key}`, '必须是非空字符串。');
      else if (item[key].length > maxLength) issue(`${path}.${key}`, `长度不能超过 ${maxLength} 个字符。`);
    };
    const optionalString = (item, key, path) => {
      if (item[key] !== undefined && !isString(item[key])) issue(`${path}.${key}`, '必须是字符串。');
    };

    validateArray('records', (item, path) => {
      requiredString(item, 'id', path, 200);
      requiredString(item, 'title', path, 1000);
      if (!isString(item.date) || !validDate(item.date)) issue(`${path}.date`, '必须是 YYYY-MM-DD 格式的有效日期。');
      if (item.minutes !== undefined && (!isFiniteNumber(item.minutes) || item.minutes < 0)) issue(`${path}.minutes`, '必须是大于等于 0 的有限数字。');
      for (const key of ['category', 'content', 'next', 'createdAt', 'updatedAt']) optionalString(item, key, path);
    });

    validateArray('resources', (item, path) => {
      requiredString(item, 'id', path, 200);
      requiredString(item, 'title', path, 1000);
      requiredString(item, 'url', path, 4096);
      try {
        const url = new URL(item.url);
        if (!['http:', 'https:'].includes(url.protocol)) issue(`${path}.url`, '只允许 HTTP 或 HTTPS 地址。');
      } catch (_) {
        issue(`${path}.url`, '必须是有效的 HTTP 或 HTTPS 地址。');
      }
      for (const key of ['category', 'tag', 'desc', 'createdAt', 'updatedAt']) optionalString(item, key, path);
    });

    validateArray('notes', (item, path) => {
      requiredString(item, 'id', path, 200);
      requiredString(item, 'title', path, 1000);
      for (const key of ['category', 'content', 'createdAt', 'updatedAt']) optionalString(item, key, path);
    });

    function validateLesson(lesson, path) {
      if (!isPlainObject(lesson)) {
        issue(path, '必须是对象。');
        return;
      }
      requiredString(lesson, 'id', path, 200);
      requiredString(lesson, 'title', path, 1000);
      for (const key of ['stage', 'summary', 'editableContent', 'exercise', 'exerciseAnswer', 'reference']) optionalString(lesson, key, path);
      if (lesson.minutes !== undefined && (!isFiniteNumber(lesson.minutes) || lesson.minutes < 0)) issue(`${path}.minutes`, '必须是大于等于 0 的有限数字。');
      if (lesson.sections !== undefined && (!Array.isArray(lesson.sections) || lesson.sections.some(section => !isPlainObject(section)))) issue(`${path}.sections`, '必须是对象数组。');
      if (lesson.takeaways !== undefined && (!Array.isArray(lesson.takeaways) || lesson.takeaways.some(value => !isString(value)))) issue(`${path}.takeaways`, '必须是字符串数组。');
    }

    validateArray('customCourses', (course, path) => {
      requiredString(course, 'id', path, 200);
      requiredString(course, 'title', path, 1000);
      if (!Array.isArray(course.lessons)) {
        issue(`${path}.lessons`, '必须是课时数组。');
      } else {
        const seenLessons = new Set();
        course.lessons.forEach((lesson, index) => {
          const lessonPath = `${path}.lessons[${index}]`;
          validateLesson(lesson, lessonPath);
          if (isPlainObject(lesson) && typeof lesson.id === 'string') {
            if (seenLessons.has(lesson.id)) issue(`${lessonPath}.id`, '同一课程中不能重复。');
            seenLessons.add(lesson.id);
          }
        });
      }
      for (const key of ['category', 'level', 'duration', 'color', 'icon', 'code', 'desc']) optionalString(course, key, path);
    });

    for (const key of ['courseEdits', 'lessonEdits', 'stageEdits']) {
      const map = candidate[key];
      if (map === undefined) continue;
      if (!isPlainObject(map)) {
        issue(key, '必须是对象映射。');
        continue;
      }
      for (const [entryKey, entry] of Object.entries(map)) {
        const path = `${key}.${entryKey}`;
        if (!entryKey || !isPlainObject(entry)) {
          issue(path, '映射值必须是对象。');
          continue;
        }
        const textFields = key === 'courseEdits'
          ? ['title', 'category', 'level', 'duration', 'desc']
          : key === 'stageEdits'
            ? ['title', 'goal']
            : ['title', 'summary', 'editableContent', 'exercise', 'exerciseAnswer', 'reference'];
        for (const field of textFields) optionalString(entry, field, path);
        if (key === 'lessonEdits') {
          if (entry.minutes !== undefined && (!isFiniteNumber(entry.minutes) || entry.minutes < 0)) issue(`${path}.minutes`, '必须是大于等于 0 的有限数字。');
          if (entry.sections !== undefined && !Array.isArray(entry.sections)) issue(`${path}.sections`, '必须是数组。');
          if (entry.takeaways !== undefined && (!Array.isArray(entry.takeaways) || entry.takeaways.some(value => !isString(value)))) issue(`${path}.takeaways`, '必须是字符串数组。');
        }
      }
    }

    if (candidate.addedLessons !== undefined) {
      if (!isPlainObject(candidate.addedLessons)) {
        issue('addedLessons', '必须是按课程 ID 索引的对象。');
      } else {
        for (const [courseId, lessons] of Object.entries(candidate.addedLessons)) {
          if (!courseId || !Array.isArray(lessons)) {
            issue(`addedLessons.${courseId}`, '必须是课时数组。');
            continue;
          }
          const seen = new Set();
          lessons.forEach((lesson, index) => {
            const path = `addedLessons.${courseId}[${index}]`;
            validateLesson(lesson, path);
            if (isPlainObject(lesson) && typeof lesson.id === 'string') {
              if (seen.has(lesson.id)) issue(`${path}.id`, '同一课程中不能重复。');
              seen.add(lesson.id);
            }
          });
        }
      }
    }

    return errors;
  }

  function unwrapBackup(parsed) {
    if (!isPlainObject(parsed)) throw new Error('备份文件必须是 JSON 对象。');
    if (Object.prototype.hasOwnProperty.call(parsed, 'state')) {
      if (!isPlainObject(parsed.state)) throw new Error('备份文件包含 state 字段，但其内容不是有效的工作区对象。');
      return parsed.state;
    }
    return parsed;
  }

  const api = Object.freeze({ validate: validateWorkspace, isPlainObject, unwrapBackup });
  root.EmbeddedWorkspaceSchema = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
