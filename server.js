const express = require('express');
const fs = require('fs/promises');
const path = require('path');

const app = express();
const config = require('./project.config');
const PORT = process.env.PORT || config.port || 3900;
const DB_FILE = path.join(__dirname, 'data', 'db.json');

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const SOUND_OBSERVATIONS = 'soundObservations';
const CONFIRM_GAP_MS = 2 * 60 * 60 * 1000;
const REQUIRED_CONFIRMS = 2;

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw);
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

function stamp(action, note, at) {
  return {
    at: at || new Date().toISOString(),
    action,
    note: note || ''
  };
}

function pushHistory(item, action, note, at) {
  item.history = item.history || [];
  item.history.unshift(stamp(action, note, at));
}

function touch(item, at) {
  item.updatedAt = at || new Date().toISOString();
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

function nowIso() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// 声环境恢复观察单
// ---------------------------------------------------------------------------

function isExceeding(soundLevel, limit) {
  const level = Number(soundLevel);
  const lim = Number(limit);
  return Number.isFinite(level) && Number.isFinite(lim) && level > lim;
}

function openObservation(db, siteId) {
  return (db[SOUND_OBSERVATIONS] || []).find(
    (entry) => entry.siteId === siteId && entry.status === '观察中'
  );
}

function activeReports(db, observationId) {
  return (db.surveys || [])
    .filter((survey) => survey.observationId === observationId && !survey.reportVoided)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

// 当前仍有效的确认，按时间正序
function validConfirmations(observation) {
  return (observation.confirmations || [])
    .filter((record) => record.valid)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
}

// 连续确认进度：同一人连续合格，间隔不少于 2 小时
function confirmProgress(observation) {
  const records = validConfirmations(observation);
  const chain = [];
  for (const record of records) {
    if (!chain.length) {
      chain.push(record);
      continue;
    }
    const previous = chain[chain.length - 1];
    if (record.surveyor !== previous.surveyor) break; // 必须由同一位巡测员连续确认
    if (new Date(record.at) - new Date(previous.at) < CONFIRM_GAP_MS) break; // 间隔不少于 2 小时
    chain.push(record);
  }
  return { chain, count: chain.length, remaining: Math.max(0, REQUIRED_CONFIRMS - chain.length) };
}

function peakOf(db, observation) {
  const levels = activeReports(db, observation.id).map((survey) => Number(survey.soundLevel));
  const valid = levels.filter((level) => Number.isFinite(level));
  return valid.length ? Math.max(...valid) : null;
}

// 是否仍有有效超限上报；无有效上报（如全部修订为达标）视为不再超限
function stillExceeding(db, observation, limit) {
  const peak = peakOf(db, observation);
  return { peak, exceeds: peak !== null && isExceeding(peak, limit) };
}

function protectSite(site) {
  if (site && site.protectedStatus !== '重点保护') {
    site.previousProtectedStatus = site.protectedStatus || '常规观察';
    site.protectedStatus = '重点保护';
    touch(site);
    pushHistory(site, '重点保护', '声环境观察期间重点保护');
  }
}

function restoreSiteIfClear(db, site) {
  if (!site || site.protectedStatus !== '重点保护') return false;
  const stillOpen = (db[SOUND_OBSERVATIONS] || []).some(
    (entry) => entry.siteId === site.id && entry.status === '观察中'
  );
  if (stillOpen) return false;
  const fallback = site.previousProtectedStatus || '常规观察';
  site.protectedStatus = fallback;
  delete site.previousProtectedStatus;
  touch(site);
  pushHistory(site, '恢复保护状态', `声环境已恢复，恢复为${fallback}`);
  return true;
}

function closeObservation(db, observation, site, action, note, at) {
  observation.status = '已恢复';
  observation.recoveredAt = at || nowIso();
  touch(observation, at);
  pushHistory(observation, action, note, at);
  restoreSiteIfClear(db, site);
}

function resetConfirms(observation, note, at) {
  for (const record of observation.confirmations || []) {
    if (record.valid) record.valid = false;
  }
  observation.remaining = REQUIRED_CONFIRMS;
  touch(observation, at);
  pushHistory(observation, '确认进度清零', note, at);
}

function createObservation(db, survey, site, at) {
  const reports = [
    {
      surveyId: survey.id,
      surveyor: survey.surveyor,
      soundLevel: Number(survey.soundLevel),
      groupSize: Number(survey.groupSize) || 0,
      at: at
    }
  ];
  const observation = {
    id: `soundobs-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    siteId: site.id,
    status: '观察中',
    owner: survey.surveyor,
    reportCount: 1,
    reports,
    peak: Number(survey.soundLevel),
    limitAtOpen: Number(site.soundLimit),
    confirmations: [],
    remaining: REQUIRED_CONFIRMS,
    createdAt: at,
    updatedAt: at,
    openedAt: at,
    recoveredAt: '',
    history: [
      stamp(
        '建立观察单',
        `峰值 ${survey.soundLevel} dB 超过样点限值 ${site.soundLimit} dB，团队 ${survey.groupSize || 0} 人`,
        at
      )
    ]
  };
  db[SOUND_OBSERVATIONS].push(observation);
  survey.observationId = observation.id;
  protectSite(site);
  return observation;
}

/**
 * 一次超限上报：有未结束观察单则累加次数，否则建单。
 * 返回 { type: 'created' | 'updated', observation }
 */
function registerExceeding(db, survey, site, at = nowIso()) {
  const existing = openObservation(db, site.id);
  if (existing) {
    existing.reportCount += 1;
    existing.reports = existing.reports || [];
    existing.reports.push({
      surveyId: survey.id,
      surveyor: survey.surveyor,
      soundLevel: Number(survey.soundLevel),
      groupSize: Number(survey.groupSize) || 0,
      at
    });
    existing.peak = Math.max(Number(existing.peak) || -Infinity, Number(survey.soundLevel));
    survey.observationId = existing.id;
    // 新的超限打断此前的合格复测：两次确认必须连续
    if ((existing.confirmations || []).some((record) => record.valid)) {
      resetConfirms(existing, `再次上报峰值 ${survey.soundLevel} dB，复测需重新连续确认`, at);
    }
    touch(existing, at);
    pushHistory(
      existing,
      '累加超限上报',
      `第 ${existing.reportCount} 次，峰值 ${survey.soundLevel} dB，团队 ${survey.groupSize || 0} 人`,
      at
    );
    return { type: 'updated', observation: existing };
  }
  return { type: 'created', observation: createObservation(db, survey, site, at) };
}

/**
 * 巡测修订后按当前限值重判关联的未结束观察单。
 */
function rejudgeObservationForSurvey(db, survey, site, at = nowIso()) {
  if (!site) return null;
  const observation = openObservation(db, site.id);
  if (!observation) {
    // 修订后仍超限且没有观察单 -> 建单
    if (isExceeding(survey.soundLevel, site.soundLimit)) {
      return registerExceeding(db, survey, site, at);
    }
    return null;
  }

  if (survey.observationId === observation.id && !survey.reportVoided) {
    if (!isExceeding(survey.soundLevel, site.soundLimit)) {
      // 原超限记录修订为达标：该次上报作废，保留在 reports 履历中
      survey.reportVoided = true;
      pushHistory(observation, '上报记录失效', `巡测 ${survey.id} 声级修订为 ${survey.soundLevel} dB，不再超限`, at);
    } else {
      // 仍超限，更新该次上报数据，等价一次新的超限事件（打断确认进度）
      const record = (observation.reports || []).find((entry) => entry.surveyId === survey.id);
      if (record) {
        record.soundLevel = Number(survey.soundLevel);
        record.groupSize = Number(survey.groupSize) || record.groupSize;
        record.at = at;
        record.revised = true;
      }
      if ((observation.confirmations || []).some((entry) => entry.valid)) {
        resetConfirms(observation, `巡测 ${survey.id} 修订后仍为 ${survey.soundLevel} dB，复测需重新连续确认`, at);
      }
    }
  } else if (isExceeding(survey.soundLevel, site.soundLimit)) {
    return registerExceeding(db, survey, site, at);
  }

  const { peak, exceeds } = stillExceeding(db, observation, site.soundLimit);
  if (peak !== null) observation.peak = peak;
  touch(observation, at);

  if (!exceeds) {
    closeObservation(
      db,
      observation,
      site,
      '重判通过',
      `按新值重判：已无超限上报（峰值 ${peak === null ? '无' : peak} dB / 限值 ${site.soundLimit} dB），旧结论保留在履历`,
      at
    );
    return { type: 'rejudged-recovered', observation };
  }
  pushHistory(
    observation,
    '按新值重判',
    `峰值 ${observation.peak} dB 仍高于限值 ${site.soundLimit} dB，继续观察`,
    at
  );
  return { type: 'rejudged-open', observation };
}

/**
 * 样点限值修订：对该样点全部未结束观察单按新值重判。
 * 旧确认结论：低于新限值保留，超过则作废；旧结论不动，仅追加履历。
 */
function rejudgeObservationForSite(db, site, oldLimit, at = nowIso()) {
  const newLimit = Number(site.soundLimit);
  const results = [];
  for (const observation of (db[SOUND_OBSERVATIONS] || [])) {
    if (observation.siteId !== site.id || observation.status !== '观察中') continue;

    const before = confirmProgress(observation);
    for (const record of observation.confirmations || []) {
      if (!record.valid) continue;
      if (Number(record.soundLevel) >= newLimit) {
        record.valid = false;
        record.invalidatedAt = at;
        record.invalidReason = `限值由 ${oldLimit} 调整为 ${newLimit} dB 后不再达标`;
        pushHistory(observation, '旧确认结论作废', `复测 ${record.soundLevel} dB 不满足新限值 ${newLimit} dB，旧结论保留`, at);
      }
    }
    const after = confirmProgress(observation);
    observation.remaining = after.remaining;
    if (before.count > 0 && after.count === 0) {
      pushHistory(observation, '确认进度清零', `样点限值修订为 ${newLimit} dB，连续确认重新计算`, at);
    }

    const { peak, exceeds } = stillExceeding(db, observation, newLimit);
    if (peak !== null) observation.peak = peak;
    touch(observation, at);

    if (!exceeds) {
      closeObservation(
        db,
        observation,
        site,
        '重判通过',
        `限值由 ${oldLimit} 调整为 ${newLimit} dB，峰值 ${peak === null ? '无有效超限上报' : peak + ' dB'} 已达标，旧结论保留在履历`,
        at
      );
      results.push({ type: 'rejudged-recovered', observation });
    } else {
      pushHistory(
        observation,
        '限值修订重判',
        `限值由 ${oldLimit} 调整为 ${newLimit} dB，峰值 ${observation.peak} dB 仍超限，继续观察`,
        at
      );
      results.push({ type: 'rejudged-open', observation });
    }
  }
  return results;
}

/**
 * 复测登记：
 * - 必须由非上报人（另一位巡测员）执行
 * - 连续两次合格，且两次间隔不少于 2 小时
 * - 不合格则清空进度
 */
function registerSoundCheck(db, observation, body, atIso) {
  const at = atIso || nowIso();
  if (observation.status !== '观察中') return { error: '观察单已结束，无需复测' };
  const surveyor = String(body.surveyor || '').trim();
  const soundLevel = Number(body.soundLevel);
  if (!surveyor) return { error: '请填写复测人员' };
  if (!Number.isFinite(soundLevel)) return { error: '请填写复测声级' };
  if (surveyor === observation.owner) {
    return { error: `需由另一位巡测员确认（上报人：${observation.owner}）` };
  }
  const site = db.sites.find((entry) => entry.id === observation.siteId);
  if (!site) return { error: '关联样点不存在' };
  const limit = Number(site.soundLimit);

  // 新记录入库前的连续确认链
  const before = confirmProgress(observation);
  const record = {
    surveyor,
    soundLevel,
    limit,
    at,
    valid: soundLevel < limit
  };
  observation.confirmations = observation.confirmations || [];
  observation.confirmations.unshift(record);
  touch(observation, at);

  if (!record.valid) {
    resetConfirms(observation, `${surveyor} 复测 ${soundLevel} dB 未低于限值 ${limit} dB`, at);
    return { error: `复测 ${soundLevel} dB 未低于限值 ${limit} dB，确认进度已清零` };
  }

  if (before.count === 0) {
    observation.remaining = REQUIRED_CONFIRMS - 1;
    pushHistory(observation, '第一次合格复测', `${surveyor} 复测 ${soundLevel} dB < ${limit} dB，还需 1 次`, at);
    return { observation, check: { phase: 'first', record } };
  }

  // 第二次：必须与链上最后一位为同一人，且与上一次间隔不少于 2 小时
  const previous = before.chain[before.count - 1];
  if (previous.surveyor !== surveyor) {
    resetConfirms(observation, `第二次须由同一位巡测员（${previous.surveyor}）连续确认`, at);
    return { error: `两次确认须为同一位巡测员（第一次：${previous.surveyor}）` };
  }
  const gap = new Date(at) - new Date(previous.at);
  if (gap < CONFIRM_GAP_MS) {
    const hours = (gap / 3600000).toFixed(1);
    resetConfirms(observation, `与上一次仅间隔 ${hours} 小时，不足 2 小时`, at);
    return { error: `两次确认间隔不足 2 小时（当前 ${hours} 小时）` };
  }

  if (before.count + 1 < REQUIRED_CONFIRMS) {
    observation.remaining = REQUIRED_CONFIRMS - before.count - 1;
    pushHistory(observation, '合格复测', `${surveyor} 复测 ${soundLevel} dB < ${limit} dB`, at);
    return { observation, check: { phase: 'continue', record } };
  }

  observation.remaining = 0;
  pushHistory(
    observation,
    '第二次合格复测',
    `${surveyor} 复测 ${soundLevel} dB < ${limit} dB，与首次间隔 ${(gap / 3600000).toFixed(1)} 小时`,
    at
  );
  closeObservation(
    db,
    observation,
    site,
    '恢复确认完成',
    `${surveyor} 连续两次复测低于限值（间隔 ${(gap / 3600000).toFixed(1)} 小时），声环境恢复`,
    at
  );
  return { observation, check: { phase: 'second', record } };
}

// ---------------------------------------------------------------------------
// 接口
// ---------------------------------------------------------------------------

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
  if (collection === SOUND_OBSERVATIONS) {
    return res.status(403).json({ error: '观察单由超限巡测自动建立，请先登记巡测' });
  }
  const now = nowIso();
  const item = {
    id: `${collection}-${Date.now()}-${Math.random().toString(16).slice(2, 7)}`,
    ...req.body,
    createdAt: now,
    updatedAt: now,
    history: [stamp('创建', req.body.note || req.body.memo || '')]
  };
  db[collection].push(item);

  let soundEvent = null;
  if (collection === 'surveys') {
    const site = db.sites.find((entry) => entry.id === item.siteId);
    if (site && Number.isFinite(Number(item.soundLevel))) {
      if (isExceeding(item.soundLevel, site.soundLimit)) {
        soundEvent = registerExceeding(db, item, site, now);
      } else {
        soundEvent = { type: 'within-limit', observation: null };
      }
    }
  }
  await writeDb(db);
  res.status(201).json({ ...item, soundEvent });
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const oldSoundLevel = item.soundLevel;
  const oldLimit = item.soundLimit;
  const historyAction = req.body.historyAction;
  delete req.body.historyAction;
  Object.assign(item, req.body, { updatedAt: nowIso() });
  item.history = item.history || [];
  if (historyAction || req.body.note || req.body.memo || req.body.status) {
    pushHistory(item, historyAction || req.body.status || '更新', req.body.note || req.body.memo || '');
  }

  let soundEvent = null;
  if (collection === 'surveys' && req.body.soundLevel !== undefined && Number(req.body.soundLevel) !== Number(oldSoundLevel)) {
    const site = db.sites.find((entry) => entry.id === item.siteId);
    soundEvent = rejudgeObservationForSurvey(db, item, site) || { type: 'unrelated', observation: null };
    pushHistory(item, '修订声级', `${oldSoundLevel} dB → ${req.body.soundLevel} dB，已按当前限值重判`);
  }
  if (collection === 'sites' && req.body.soundLimit !== undefined && Number(req.body.soundLimit) !== Number(oldLimit)) {
    pushHistory(item, '修订声级限值', `${oldLimit} dB → ${req.body.soundLimit} dB，未结束观察按新值重判`);
    const results = rejudgeObservationForSite(db, item, oldLimit);
    soundEvent = { type: 'limit-revised', results };
  }

  await writeDb(db);
  res.json({ ...item, soundEvent });
});

app.delete('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  if (collection === SOUND_OBSERVATIONS && item.status === '观察中') {
    const site = db.sites.find((entry) => entry.id === item.siteId);
    db[collection] = db[collection].filter((entry) => entry.id !== id);
    if (site) restoreSiteIfClear(db, site);
  } else {
    db[collection] = db[collection].filter((entry) => entry.id !== id);
  }
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

// 复测登记（声环境观察）
app.post('/api/sound-observations/:id/checks', async (req, res) => {
  const db = await readDb();
  const observation = db[SOUND_OBSERVATIONS]?.find((entry) => entry.id === req.params.id);
  if (!observation) return res.status(404).json({ error: 'not found' });
  const at = req.body.at || nowIso();
  const result = registerSoundCheck(db, observation, req.body || {}, at);
  if (result.error) {
    await writeDb(db); // 不合格复测也留痕
    return res.status(409).json({ error: result.error, observation });
  }
  await writeDb(db);
  res.status(201).json(result);
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
    pushHistory(target, action.label, action.note || '状态流转');
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
    pushHistory(target, action.label, action.note || '数量调整');
  }
  return { item };
}

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
