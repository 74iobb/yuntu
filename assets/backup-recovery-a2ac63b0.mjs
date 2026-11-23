const STATE_KEY = 'yutu.state.v2';
const MARKS_KEY = 'yutu.marked';
const MAX_BYTES = 5 * 1024 * 1024;
const CHOICES = ['keep', 'revise', 'rest', 'switch'];
const SCORE_KEYS = ['place', 'econ', 'family', 'age', 'cycle', 'inertia', 'history'];

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const string = value => typeof value === 'string';
const id = value => string(value) && value.trim().length > 0;
const date = value => string(value) && Number.isFinite(Date.parse(value));
const fields = (value, keys) => object(value) && keys.every(key => string(value[key]));
const scores = value => object(value) && SCORE_KEYS.every(key =>
  Number.isFinite(value[key]) && value[key] >= 0 && value[key] <= 100
);
const optionalId = value => value === undefined || id(value);
const step = value => Number.isInteger(value) && value >= 1 && value <= 4;
const unique = values => new Set(values).size === values.length;
const list = (value, check, key = item => item) =>
  Array.isArray(value) && value.every(check) && unique(value.map(key));

function validProfile(value) {
  return fields(value, ['city', 'urban', 'identity', 'field']) && id(value.city) &&
    ['core', 'suburb', 'county'].includes(value.urban) &&
    ['study', 'work'].includes(value.identity) && scores(value.s);
}

function validTask(value) {
  return fields(value, ['id', 'title', 'type', 'origin', 'sourceId', 'nodeName', 'pre', 'risk', 'std']) &&
    id(value.id) && optionalId(value.backendId) &&
    ['doing', 'done', 'hold', 'drop'].includes(value.status) &&
    typeof value.custom === 'boolean' && typeof value.archived === 'boolean';
}

function validVictory(value) {
  return object(value) && id(value.id) && optionalId(value.backendId) &&
    Number.isInteger(value.no) && value.no >= 1 && date(value.at) && scores(value.snap) &&
    string(value.domain) && Number.isFinite(value.sim) && CHOICES.includes(value.choice) &&
    list(value.tasks, task => fields(task, ['id', 'title', 'type']) && id(task.id) &&
      (task.sourceId === undefined || string(task.sourceId)), task => task.id) &&
    fields(value.answers, ['feel', 'ctx', 'vision']);
}

function validReview(value, ownerKey) {
  return fields(value, ['id', 'authorKey', 'authorName', 'stage', 'city', 'content']) &&
    id(value.id) && value.authorKey === ownerKey &&
    ['explore', 'entry', 'pivot', 'anchor'].includes(value.stage) &&
    CHOICES.includes(value.choice) && (value.vector === null || scores(value.vector)) &&
    date(value.createdAt);
}

export function parseBackup(text) {
  let backup;
  try {
    backup = JSON.parse(text.replace(/^\uFEFF/, ''));
  } catch {
    throw new Error('文件不是有效的 JSON。请重新选择域途导出的完整备份。');
  }
  if (!object(backup) || backup.app !== '域途' || backup.format !== 'yutu-backup-v1') {
    throw new Error('不支持这个备份格式或版本。请选择域途导出的完整备份 JSON。');
  }
  if (!date(backup.exportedAt) || !id(backup.ownerKey) || !validProfile(backup.profile) ||
      !list(backup.tasks, validTask, task => task.id) ||
      !list(backup.victories, validVictory, victory => victory.id) ||
      !list(backup.myReviews, value => validReview(value, backup.ownerKey), review => review.id) ||
      !object(backup.markCounts) ||
      !Object.values(backup.markCounts).every(count => Number.isSafeInteger(count) && count >= 0) ||
      !list(backup.markedIds, id) || !list(backup.shortlist, id) || backup.shortlist.length > 4 ||
      !step(backup.step) || !step(backup.maxStep) || backup.step > backup.maxStep) {
    throw new Error('备份缺少必要数据，或任务、档案和进度的格式无效。');
  }
  return backup;
}

export function restoreBackup(storage, backup, ownerKey) {
  const { profile, tasks, victories, myReviews, markCounts, shortlist, maxStep, markedIds } = backup;
  // A single write replaces the personal snapshot and its marks together.
  const restored = {
    profile,
    tasks,
    victories,
    reviews: myReviews.map(review => ({ ...review, authorKey: ownerKey, restoredPrivate: true })),
    markCounts,
    shortlist,
    markedIds,
    step: backup.step,
    maxStep,
    stepSchema: 4,
    restoredAt: Date.now(),
  };
  storage.setItem(STATE_KEY, JSON.stringify(restored));
  return restored;
}

function savedState(storage) {
  return JSON.parse(storage.getItem(STATE_KEY) || 'null');
}

export function readBackupMarks(storage) {
  return savedState(storage)?.markedIds ?? JSON.parse(storage.getItem(MARKS_KEY) || '[]');
}

export function persistBackupMarks(storage, markedIds) {
  const current = savedState(storage);
  if (current?.markedIds) {
    storage.setItem(STATE_KEY, JSON.stringify({ ...current, markedIds }));
  } else {
    storage.setItem(MARKS_KEY, JSON.stringify(markedIds));
  }
}

export function persistBackupState(storage, snapshot) {
  const current = savedState(storage);
  storage.setItem(STATE_KEY, JSON.stringify({
    ...snapshot,
    markedIds: current?.markedIds,
    restoredAt: current?.restoredAt,
    stepSchema: 4,
  }));
}

export function restoredStep(snapshot, value, migrateStep) {
  return snapshot?.stepSchema === 4 && step(value) ? value : migrateStep(value);
}

export function BackupRecovery({ react, jsx, state, restore, downloadCurrent, showArchive }) {
  const { useRef, useState } = react;
  const { jsx: element, jsxs: group } = jsx;
  const [backup, setBackup] = useState(null);
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const selection = useRef(0);
  const disabled = !state.hydrated || state.backendOnline || state.syncing;
  const restored = state.restoredAt;
  const privateReviewCount = state.reviews.filter(review => review.restoredPrivate).length;

  async function readFile(event) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = '';
    const request = ++selection.current;
    setBackup(null);
    setError('');
    if (!file) {
      setReading(false);
      return;
    }
    if (file.size > MAX_BYTES) {
      setReading(false);
      setError('备份文件超过 5 MB，无法读取。');
      return;
    }
    setReading(true);
    try {
      const parsed = parseBackup(await file.text());
      if (request === selection.current) setBackup(parsed);
    } catch (failure) {
      if (request === selection.current) setError(failure.message || '无法读取备份文件。');
    } finally {
      if (request === selection.current) setReading(false);
    }
  }

  function confirmRestore() {
    if (!backup || disabled) return;
    try {
      restore(backup);
    } catch {
      setError('浏览器无法保存备份，可能是存储空间不足。当前数据未被替换。');
      return;
    }
    setBackup(null);
    setError('');
  }

  const button = (label, onClick, disabled = false) => element('button', {
    type: 'button', className: 'y-btn y-btn-s', onClick, disabled, children: label,
  });

  return group('section', {
    'aria-label': '从备份恢复',
    children: [
      element('h4', { children: '从备份恢复' }),
      element('p', {
        className: 'y-note',
        children: state.backendOnline
          ? '当前连接平台数据表。请在本地存储模式下恢复备份。'
          : '选中的完整备份会替换当前浏览器的数据。恢复的复盘保存在本机。',
      }),
      group('label', {
        children: [
          '选择完整备份 JSON ',
          element('input', { type: 'file', accept: '.json,application/json', onChange: readFile, disabled }),
        ],
      }),
      reading ? element('p', { role: 'status', children: '正在读取备份…' }) : null,
      error ? element('p', { role: 'alert', children: error }) : null,
      backup ? group('div', {
        className: 'y-confirm',
        children: [
          element('p', {
            children: `备份日期 ${new Date(backup.exportedAt).toLocaleString('zh-CN')} · ${backup.tasks.length} 条任务 · ${backup.victories.length} 条阶段性胜利 · ${backup.myReviews.length} 条复盘 · ${backup.shortlist.length} 条方向候选`,
          }),
          element('p', { children: '确认后，此备份将覆盖当前浏览器的个人数据。' }),
          group('div', {
            className: 'y-row',
            children: [
              button('先下载当前备份', downloadCurrent),
              button('取消恢复', () => { setBackup(null); setError(''); }),
              button('确认替换并恢复', confirmRestore, disabled),
            ],
          }),
        ],
      }) : null,
      restored ? group('div', {
        children: [
          element('p', {
            role: 'status',
            children: `已从备份恢复。当前有 ${state.tasks.length} 条任务、${state.victories.length} 条阶段性胜利和 ${privateReviewCount} 条恢复的个人复盘。`,
          }),
          button('查看胜利档案墙', showArchive),
        ],
      }) : null,
    ],
  });
}
