const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = process.env.DB_FILE || path.join(__dirname, 'data', 'db.json');

// 声环境恢复规则：另一位巡测员连续 2 次确认低于限值，间隔不少于 2 小时
const CONFIRMATIONS_NEEDED = 2;
const CONFIRM_GAP_MS = 2 * 60 * 60 * 1000;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note) {
  return {
    at: new Date().toISOString(),
    action,
    note: note || ''
  };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.get('/api/db', async (req, res) => {
  const db = await readDb();
  for (const key of Object.keys(db)) {
    if (Array.isArray(db[key])) db[key].sort(sortNewest);
  }
  res.json(db);
});

app.post('/api/:collection', async (req, res) => {
  const db = await readDb();
  const { collection } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const now = new Date().toISOString();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);
  // 声环境恢复记录：巡测绑定样点、声级、团队人数，按规则联动观察单
  const notice = collection === 'surveys' ? ingestSurvey(db, item) : null;
  await writeDb(db);
  res.status(201).json(notice ? { item, notice } : item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    item.history.unshift(stamp(historyAction || req.body.status || '更新', req.body.note || req.body.memo || ''));
  }
  // 修订巡测或样点限值后，按新值重判未结束的观察单，旧结论留在履历
  let notice = null;
  if (collection === 'surveys' && (req.body.soundLevel !== undefined || req.body.siteId !== undefined)) {
    notice = rejudgeSite(db, item.siteId, '巡测修订');
  }
  if (collection === 'sites' && req.body.noiseLimit !== undefined) {
    notice = rejudgeSite(db, item.id, `限值修订为 ${item.noiseLimit} dB`);
  }
  await writeDb(db);
  res.json(notice ? { item, notice } : item);
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const before = db[collection].length;
  db[collection] = db[collection].filter((entry) => entry.id !== id);
  if (db[collection].length === before) return res.status(404).json({ error: 'not found' });
  await writeDb(db);
  res.status(204).end();
});

app.post('/api/action/:actionId/:id', async (req, res) => {
  const db = await readDb();
  const action = config.actions.find((entry) => entry.id === req.params.actionId);
  if (!action) return res.status(404).json({ error: 'unknown action' });
  const item = db[action.collection]?.find((entry) => entry.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'not found' });
  const result = runAction(db, action, item);
  if (result.error) return res.status(409).json({ error: result.error });
  await writeDb(db);
  res.json(result.item);
});

function getValue(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function setValue(target, pathName, value) {
  const keys = pathName.split('.');
  let cursor = target;
  while (keys.length > 1) {
    const key = keys.shift();
    cursor[key] = cursor[key] || {};
    cursor = cursor[key];
  }
  cursor[keys[0]] = value;
}

function findRelated(db, relation, item) {
  return db[relation.collection]?.find((entry) => entry.id === item[relation.localKey]);
}

function runAction(db, action, item) {
  const related = action.relation ? findRelated(db, action.relation, item) : null;
  const context = { item, related };
  const levelRank = { '低': 1, '中': 2, '高': 3 };
  for (const guard of action.guards || []) {
    const left = getValue(context, guard.left);
    const right = guard.rightPath ? getValue(context, guard.rightPath) : guard.right;
    if (guard.op === 'missing' && left) continue;
    if (guard.op === 'missing' && !left) return { error: guard.message };
    if (guard.op === 'eq' && left !== right) return { error: guard.message };
    if (guard.op === 'neq' && left === right) return { error: guard.message };
    if (guard.op === 'gte' && Number(left) < Number(right)) return { error: guard.message };
    if (guard.op === 'levelGte' && (levelRank[left] || 0) < (levelRank[right] || 0)) return { error: guard.message };
    if (guard.op === 'notIn' && guard.values.includes(left)) return { error: guard.message };
  }
  for (const patch of action.patches || []) {
    const target = patch.target === 'related' ? related : item;
    if (!target) continue;
    const next = patch.valuePath ? getValue(context, patch.valuePath) : patch.value;
    setValue(target, patch.field, next);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '状态流转'));
  }
  for (const delta of action.deltas || []) {
    const target = delta.target === 'related' ? related : item;
    if (!target) continue;
    const sourceAmount = delta.amountPath ? Number(getValue(context, delta.amountPath)) : 1;
    const multiplier = delta.amount === undefined ? 1 : Number(delta.amount);
    const amount = sourceAmount * multiplier;
    const current = Number(getValue({ target }, `target.${delta.field}`) || 0);
    setValue(target, delta.field, current + amount);
    target.updatedAt = new Date().toISOString();
    target.history = target.history || [];
    target.history.unshift(stamp(action.label, action.note || '数量调整'));
  }
  return { item };
}

// ============ 声环境恢复记录 ============

function surveyTime(survey) {
  return new Date(survey.measuredAt || survey.createdAt || 0).getTime();
}

function makeConf(survey) {
  return {
    surveyId: survey.id,
    surveyor: survey.surveyor,
    soundLevel: Number(survey.soundLevel),
    at: survey.measuredAt || survey.createdAt
  };
}

function markSiteFocus(db, site, obs, reason) {
  if (site.protectedStatus !== '重点保护') {
    site.protectedStatus = '重点保护';
    site.updatedAt = new Date().toISOString();
    site.history = site.history || [];
    site.history.unshift(stamp('声环境观察', `${site.pointCode || ''} 声环境观察期间重点保护（${reason}）`));
  }
}

function restoreSite(site, reason) {
  if (site.protectedStatus === '重点保护') {
    site.protectedStatus = '常规观察';
    site.updatedAt = new Date().toISOString();
    site.history = site.history || [];
    site.history.unshift(stamp('解除重点保护', `${site.pointCode || ''} 声环境恢复，转常规观察（${reason}）`));
  }
}

function closeObservation(obs, site, second) {
  const first = obs.confirmations[0];
  obs.status = '已恢复';
  obs.closedAt = second.at;
  obs.confirmations.push(second);
  obs.remaining = 0;
  obs.updatedAt = new Date().toISOString();
  obs.history.unshift(stamp(
    '确认恢复',
    `${second.surveyor} 第 2 次确认 ${second.soundLevel} dB 低于限值 ${obs.noiseLimit} dB，距上次 ${Math.round((new Date(second.at) - new Date(first.at)) / 60000)} 分钟，观察结束`
  ));
  restoreSite(site, '双人两次确认');
}

function openObservation(db, site, survey) {
  const now = new Date().toISOString();
  const obs = {
    id: `obs-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId: site.id,
    status: '观察中',
    openerSurveyId: survey.id,
    opener: survey.surveyor,
    firstSurveyId: survey.id,
    latestSurveyId: survey.id,
    openedAt: survey.measuredAt || survey.createdAt || now,
    closedAt: '',
    noiseLimit: Number(site.noiseLimit),
    peakLevel: Number(survey.soundLevel),
    peakSurveyId: survey.id,
    teamSize: Number(survey.teamSize || 0),
    reportCount: 1,
    confirmations: [],
    assignee: '',
    remaining: CONFIRMATIONS_NEEDED,
    createdAt: now,
    updatedAt: now,
    history: [stamp(
      '建立观察单',
      `${survey.surveyor} 巡测峰值 ${survey.soundLevel} dB，超过样点限值 ${site.noiseLimit} dB，团队 ${survey.teamSize || 0} 人；样点转入重点保护`
    )]
  };
  db.observations.push(obs);
  markSiteFocus(db, site, obs, '峰值超限');
  return obs;
}

// 新增巡测时增量驱动观察单状态机
function ingestSurvey(db, survey) {
  const site = db.sites?.find((entry) => entry.id === survey.siteId);
  if (!site || site.noiseLimit === undefined || site.noiseLimit === null || site.noiseLimit === '') return null;
  if (survey.soundLevel === undefined || survey.soundLevel === null || survey.soundLevel === '') return null;

  const open = db.observations?.find((entry) => entry.siteId === site.id && entry.status === '观察中');
  const over = Number(survey.soundLevel) > Number(site.noiseLimit);

  // 1) 峰值超过样点限值：无单建单；未恢复前再上报只更新原单并累加次数
  if (over) {
    if (!open) {
      openObservation(db, site, survey);
      return `峰值 ${survey.soundLevel} dB 超过限值 ${site.noiseLimit} dB，已建立声环境观察单，样点转入重点保护`;
    }
    open.reportCount += 1;
    open.latestSurveyId = survey.id;
    open.teamSize = Number(survey.teamSize || 0);
    if (Number(survey.soundLevel) > Number(open.peakLevel)) {
      open.peakLevel = Number(survey.soundLevel);
      open.peakSurveyId = survey.id;
    }
    // 再次超限，之前的低于限值确认作废，需重新连续两次
    if (open.confirmations.length) {
      open.confirmations = [];
      open.assignee = '';
      open.remaining = CONFIRMATIONS_NEEDED;
    }
    open.updatedAt = new Date().toISOString();
    open.history.unshift(stamp(
      '再次超限',
      `${survey.surveyor} 上报 ${survey.soundLevel} dB 仍高于限值 ${open.noiseLimit} dB，团队 ${survey.teamSize || 0} 人，累计 ${open.reportCount} 次；确认计数清零`
    ));
    markSiteFocus(db, site, open, '仍超限');
    return `已并入原观察单（同一样点未恢复前不另开单），累计超限 ${open.reportCount} 次`;
  }

  // 2) 低于限值：观察期间需另一位巡测员连续两次确认，间隔不少于两小时
  if (!open) return null;
  if (survey.surveyor === open.opener) {
    open.history.unshift(stamp(
      '自确认不计入',
      `${survey.surveyor} 测得 ${survey.soundLevel} dB 低于限值，但需由另一位巡测员确认，本次不计入`
    ));
    open.updatedAt = new Date().toISOString();
    return '低于限值，但开单人不能自行确认恢复，需另一位巡测员确认';
  }

  const conf = makeConf(survey);
  if (!open.confirmations.length) {
    open.confirmations = [conf];
    open.assignee = survey.surveyor;
    open.remaining = 1;
    open.updatedAt = new Date().toISOString();
    open.history.unshift(stamp(
      '首次确认',
      `${survey.surveyor} 测得 ${survey.soundLevel} dB 低于限值 ${open.noiseLimit} dB，等待其第 2 次确认（间隔不少于 2 小时）`
    ));
    return `已记录第 1 次确认，还需 ${survey.surveyor} 在 2 小时后再确认 1 次`;
  }

  if (open.confirmations[0].surveyor !== survey.surveyor) {
    open.history.unshift(stamp(
      '确认人变更',
      `${survey.surveyor} 测得 ${survey.soundLevel} dB 低于限值，但第 2 次确认需由第 1 次确认人 ${open.confirmations[0].surveyor} 完成，本次不计入`
    ));
    open.updatedAt = new Date().toISOString();
    return `第 2 次确认需由 ${open.confirmations[0].surveyor} 本人完成`;
  }

  const gap = surveyTime(survey) - new Date(open.confirmations[0].at).getTime();
  if (gap < CONFIRM_GAP_MS) {
    const waitMin = Math.ceil((CONFIRM_GAP_MS - gap) / 60000);
    open.history.unshift(stamp(
      '间隔不足',
      `${survey.surveyor} 第 2 次测得 ${survey.soundLevel} dB 低于限值，但距首次确认仅 ${Math.round(gap / 60000)} 分钟，不足 2 小时（还差 ${waitMin} 分钟），不计入`
    ));
    open.updatedAt = new Date().toISOString();
    return `两次确认间隔不足 2 小时，还差约 ${waitMin} 分钟`;
  }

  closeObservation(open, site, conf);
  return '连续两次确认低于限值且间隔满 2 小时，声环境已恢复，观察单结束';
}

// 按该样点全部巡测重放状态机。可能存在多段生命周期：恢复后再次超限会另开新单。
// 已结束的重放单仅用于对账参考；未结束的重放单与存储中的"观察中"单按开单巡测匹配。
function replaySite(db, site) {
  const surveys = (db.surveys || [])
    .filter((entry) => entry.siteId === site.id && entry.soundLevel !== undefined && entry.soundLevel !== null && entry.soundLevel !== '')
    .sort((a, b) => surveyTime(a) - surveyTime(b) || new Date(a.createdAt) - new Date(b.createdAt));

  const cycles = [];
  let cur = null;

  const startCycle = (survey) => ({
    id: '',
    siteId: site.id,
    status: '观察中',
    openerSurveyId: survey.id,
    opener: survey.surveyor,
    firstSurveyId: survey.id,
    latestSurveyId: survey.id,
    openedAt: survey.measuredAt || survey.createdAt || new Date().toISOString(),
    closedAt: '',
    noiseLimit: Number(site.noiseLimit),
    peakLevel: Number(survey.soundLevel),
    peakSurveyId: survey.id,
    teamSize: Number(survey.teamSize || 0),
    reportCount: 0,
    confirmations: [],
    assignee: '',
    remaining: CONFIRMATIONS_NEEDED,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: []
  });

  const addOver = (cycle, survey) => {
    cycle.reportCount += 1;
    cycle.latestSurveyId = survey.id;
    cycle.teamSize = Number(survey.teamSize || 0);
    if (Number(survey.soundLevel) > cycle.peakLevel) {
      cycle.peakLevel = Number(survey.soundLevel);
      cycle.peakSurveyId = survey.id;
    }
    cycle.confirmations = [];
    cycle.assignee = '';
    cycle.remaining = CONFIRMATIONS_NEEDED;
  };

  for (const survey of surveys) {
    const over = Number(survey.soundLevel) > Number(site.noiseLimit);
    if (over) {
      if (!cur || cur.status === '已恢复') {
        if (cur) cycles.push(cur);
        cur = startCycle(survey);
      }
      addOver(cur, survey);
      continue;
    }
    if (!cur || cur.status === '已恢复') continue; // 首次超限前、或恢复后的低值不算确认
    if (survey.surveyor === cur.opener) continue;
    const conf = makeConf(survey);
    if (!cur.confirmations.length) {
      cur.confirmations = [conf];
      cur.assignee = survey.surveyor;
      cur.remaining = 1;
      continue;
    }
    if (cur.confirmations[0].surveyor !== survey.surveyor) continue;
    const gap = surveyTime(survey) - new Date(cur.confirmations[0].at).getTime();
    if (gap < CONFIRM_GAP_MS) continue;
    cur.confirmations.push(conf);
    cur.remaining = 0;
    cur.status = '已恢复';
    cur.closedAt = conf.at;
  }
  if (cur) cycles.push(cur);
  return cycles;
}

// 修订巡测或样点限值：按新值重判未结束观察，旧结论留在履历
function rejudgeSite(db, siteId, reason) {
  const site = db.sites?.find((entry) => entry.id === siteId);
  if (!site || site.noiseLimit === undefined || site.noiseLimit === null || site.noiseLimit === '') return null;
  db.observations = db.observations || [];

  const cycles = replaySite(db, site);
  const storedOpen = db.observations.filter((entry) => entry.siteId === site.id && entry.status === '观察中');
  const now = new Date().toISOString();
  const notices = [];

  // 1) 存储中未结束的单与重放生命周期对账：
  //    匹配到仍观察中的 -> 更新；匹配到已恢复的 -> 重判恢复；无匹配 -> 撤销（旧结论均留履历）
  for (const existing of storedOpen) {
    const matchCycle = (cycle) =>
      cycle.openerSurveyId === existing.openerSurveyId ||
      (cycle.opener === existing.opener && cycle.openedAt === existing.openedAt);
    const openCycle = cycles.find((cycle) => cycle.status === '观察中' && matchCycle(cycle));
    if (openCycle) { openCycle.id = existing.id; continue; }
    const recoveredCycle = cycles.find((cycle) => cycle.status === '已恢复' && matchCycle(cycle));
    if (recoveredCycle) {
      existing.status = '已恢复';
      existing.closedAt = recoveredCycle.closedAt;
      existing.confirmations = recoveredCycle.confirmations;
      existing.remaining = 0;
      existing.updatedAt = now;
      const second = recoveredCycle.confirmations[1];
      existing.history.unshift(stamp(
        '重判恢复',
        `按新值重判（${reason}）：${second.surveyor} 两次确认低于限值且间隔不少于 2 小时，观察结束，旧结论保留在履历`
      ));
      notices.push('已满足恢复条件，观察单结束（旧结论保留在履历）');
      continue;
    }
    existing.history.unshift(stamp('重判撤销', `按新值重判（${reason}）：该单不再成立，旧结论保留在履历`));
    existing.status = '已撤销';
    existing.closedAt = now;
    existing.remaining = 0;
    existing.updatedAt = now;
    notices.push('观察单已撤销（履历保留）');
  }

  // 2) 重放中仍观察中的生命周期：更新原单（旧结论留履历）或补建新单
  for (const cycle of cycles.filter((entry) => entry.status === '观察中')) {
    if (cycle.id) {
      const existing = db.observations.find((entry) => entry.id === cycle.id);
      const notes = [];
      if (existing.noiseLimit !== cycle.noiseLimit) notes.push(`限值 ${existing.noiseLimit}→${cycle.noiseLimit} dB`);
      if (existing.peakLevel !== cycle.peakLevel) notes.push(`峰值 ${existing.peakLevel}→${cycle.peakLevel} dB`);
      if (existing.reportCount !== cycle.reportCount) notes.push(`超限次数 ${existing.reportCount}→${cycle.reportCount}`);
      if (existing.opener !== cycle.opener) notes.push(`开单人更正为 ${cycle.opener}`);
      if (existing.confirmations.length !== cycle.confirmations.length) notes.push(`确认进度 ${existing.confirmations.length}/2→${cycle.confirmations.length}/2`);
      if (existing.assignee !== cycle.assignee) notes.push(`处理人更正为 ${cycle.assignee || '待接单'}`);
      Object.assign(existing, {
        openerSurveyId: cycle.openerSurveyId,
        opener: cycle.opener,
        firstSurveyId: cycle.firstSurveyId,
        latestSurveyId: cycle.latestSurveyId,
        openedAt: cycle.openedAt,
        noiseLimit: cycle.noiseLimit,
        peakLevel: cycle.peakLevel,
        peakSurveyId: cycle.peakSurveyId,
        teamSize: cycle.teamSize,
        reportCount: cycle.reportCount,
        confirmations: cycle.confirmations,
        assignee: cycle.assignee,
        remaining: cycle.remaining,
        updatedAt: now
      });
      existing.history.unshift(stamp(
        '按新值重判',
        `按新值重判（${reason}）${notes.length ? '：' + notes.join('，') : '，结论不变'}；旧结论保留在履历`
      ));
      notices.push(`原观察单已按新值重判，还差 ${existing.remaining} 项确认`);
    } else {
      cycle.id = `obs-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`;
      cycle.createdAt = now;
      cycle.updatedAt = now;
      cycle.history.unshift(stamp(
        '重判建立观察单',
        `按新值重判（${reason}）：${cycle.opener} 的 ${cycle.peakLevel} dB 超过限值 ${site.noiseLimit} dB，样点转入重点保护`
      ));
      db.observations.push(cycle);
      notices.push('发现超限记录，已补建观察单');
    }
  }

  // 3) 样点保护状态随重判结果流转

  if (!notices.length) return null;

  const stillOpen = db.observations.some((entry) => entry.siteId === site.id && entry.status === '观察中');
  if (stillOpen) {
    markSiteFocus(db, site, { pointCode: site.pointCode }, `重判超限（${reason}）`);
  } else {
    restoreSite(site, `重判（${reason}）`);
  }
  return `按新值重判：${[...new Set(notices)].join('；')}`;
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
