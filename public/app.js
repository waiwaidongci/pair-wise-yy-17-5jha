const state = {
  config: null,
  db: {},
  activeTab: ''
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtDate(value) {
  if (!value) return '-';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '-';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  if (hours < 24) return restMinutes ? `${hours} 小时 ${restMinutes} 分` : `${hours} 小时`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days} 天 ${restHours} 小时` : `${days} 天`;
}

function waitingMs(observation) {
  // 等待时长从最近一次超限上报算起
  const anchor = [...(observation.reports || [])]
    .map((report) => report.at)
    .sort()
    .pop();
  const end = observation.status === '观察中' ? Date.now() : new Date(observation.recoveredAt || observation.updatedAt).getTime();
  return end - new Date(anchor || observation.openedAt || observation.createdAt).getTime();
}

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2600);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || '请求失败'), { body });
  }
  if (res.status === 204) return null;
  return res.json();
}

function valueByPath(source, pathName) {
  return pathName.split('.').reduce((value, key) => value?.[key], source);
}

function collectionLabel(collection) {
  return state.config.collections[collection]?.label || collection;
}

function findSite(siteId) {
  return (state.db.sites || []).find((site) => site.id === siteId);
}

function siteLabel(site) {
  return site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未关联样点';
}

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
  const value = field.default ? `value="${escapeHtml(field.default)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<textarea name="${field.name}" ${required}></textarea></label>`;
  }
  if (field.type === 'select') {
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}</select></label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${field.wide ? 'wide' : ''}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select></label>`;
  }
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${field.type || 'text'}" name="${field.name}" ${value} ${required}></label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item, limit = 5) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, limit).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return { ...view.defaults, ...payload };
}

function renderTabs() {
  $('#tabs').innerHTML = state.config.views.map((view, index) => `
    <button class="tab${index === 0 ? ' active' : ''}" data-tab="${view.id}">${escapeHtml(view.label)}</button>
  `).join('');
  state.activeTab = state.config.views[0].id;
}

function setTab(tabId) {
  state.activeTab = tabId;
  $$('.tab').forEach((tab) => tab.classList.toggle('active', tab.dataset.tab === tabId));
  $$('.view').forEach((view) => view.classList.toggle('active', view.id === tabId));
}

function renderStats() {
  return `<div class="stats">${state.config.stats.map((stat) => {
    const items = state.db[stat.collection] || [];
    const value = stat.filter ? items.filter((item) => item[stat.filter.field] === stat.filter.value).length : items.length;
    return `<div class="stat"><span>${escapeHtml(stat.label)}</span><strong>${value}</strong></div>`;
  }).join('')}</div>`;
}

function amendButtons(item, view) {
  const fields = view.amendFields || [];
  if (!fields.length) return '';
  return fields.map((field) => `
    <button class="ghost" data-amend="${field.name}" data-collection="${view.collection}" data-id="${item.id}" data-type="${field.type || 'text'}" data-label="${escapeHtml(field.label)}" data-hint="${escapeHtml(field.hint || '')}">${escapeHtml(field.label)}</button>
  `).join('');
}

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value ?? '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  const amend = amendButtons(item, view);
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions || amend ? `<div class="actions">${actions}${amend}</div>` : ''}
    ${historyHtml(item)}
  </article>`;
}

function renderList(view) {
  const collection = view.collection;
  const query = $(`#search-${view.id}`)?.value.trim() || '';
  const status = $(`#status-${view.id}`)?.value || '';
  let items = [...(state.db[collection] || [])];
  if (query) {
    items = items.filter((item) => view.searchFields.some((field) => String(item[field] || '').includes(query)));
  }
  if (status) {
    items = items.filter((item) => item[view.statusField] === status);
  }
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(collectionLabel(collection))}</div>`;
}

// ---------------------------------------------------------------------------
// 声环境恢复队列
// ---------------------------------------------------------------------------

function confirmChain(observation) {
  const records = [...(observation.confirmations || [])]
    .filter((record) => record.valid)
    .sort((a, b) => new Date(a.at) - new Date(b.at));
  const chain = [];
  for (const record of records) {
    if (!chain.length) {
      chain.push(record);
      continue;
    }
    const previous = chain[chain.length - 1];
    if (record.surveyor !== previous.surveyor) break;
    if (new Date(record.at) - new Date(previous.at) < 2 * 3600 * 1000) break;
    chain.push(record);
  }
  return chain;
}

function checklistEntries(observation, site) {
  const limit = Number(site?.soundLimit);
  const chain = confirmChain(observation);
  const gap = chain.length >= 2 ? new Date(chain[1].at) - new Date(chain[0].at) : 0;
  return [
    {
      label: '另一位巡测员第一次复测低于限值',
      done: chain.length >= 1,
      detail: chain[0] ? `${chain[0].surveyor} · ${chain[0].soundLevel} dB @ ${fmtDate(chain[0].at)}` : `须由上报人 ${observation.owner} 以外的人员执行`
    },
    {
      label: '同一位巡测员第二次复测低于限值',
      done: chain.length >= 2,
      detail: chain[1] ? `${chain[1].surveyor} · ${chain[1].soundLevel} dB @ ${fmtDate(chain[1].at)}` : '须与第一次为同一人且连续合格'
    },
    {
      label: '两次复测间隔不少于 2 小时',
      done: chain.length >= 2,
      detail: chain.length >= 2 ? `间隔 ${fmtDuration(gap)}` : '完成两次后判定'
    },
    {
      label: `峰值低于样点限值（${Number.isFinite(limit) ? limit : '-'} dB）`,
      done: Number.isFinite(limit) && Number(observation.peak) < limit,
      detail: `当前峰值 ${observation.peak ?? '-'} dB`
    }
  ];
}

function checklist(observation, site) {
  const checks = checklistEntries(observation, site);
  return `<ul class="checklist">${checks.map((entry) => `
    <li class="${entry.done ? 'done' : ''}"><span>${entry.done ? '✓' : '○'}</span><div>${escapeHtml(entry.label)}<em>${escapeHtml(entry.detail)}</em></div></li>
  `).join('')}</ul>`;
}

function reportsHtml(observation) {
  const reports = [...(observation.reports || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!reports.length) return '';
  return `<div class="sub-list"><h4>超限上报（${observation.reportCount} 次）</h4>${reports.map((report) => `
    <div class="sub-row ${report.revised ? 'revised' : ''}">
      <span>${fmtDate(report.at)}</span>
      <span>${escapeHtml(report.surveyor)} · ${escapeHtml(report.soundLevel)} dB · ${escapeHtml(report.groupSize || 0)} 人${report.revised ? '（已修订）' : ''}</span>
    </div>`).join('')}</div>`;
}

function confirmationsHtml(observation) {
  const records = [...(observation.confirmations || [])].sort((a, b) => new Date(b.at) - new Date(a.at));
  if (!records.length) return '';
  return `<div class="sub-list"><h4>复测记录</h4>${records.map((record) => `
    <div class="sub-row ${record.valid ? 'ok-row' : 'void-row'}">
      <span>${fmtDate(record.at)}</span>
      <span>${escapeHtml(record.surveyor)} · ${escapeHtml(record.soundLevel)} dB / 限值 ${escapeHtml(record.limit)} dB · ${record.valid ? '有效' : '已作废'}${record.invalidReason ? '：' + escapeHtml(record.invalidReason) : ''}</span>
    </div>`).join('')}</div>`;
}

function checkForm(observation) {
  if (observation.status !== '观察中') return '';
  return `<form class="check-form" data-sound-check="${observation.id}">
    <h4>登记复测（须为非上报人）</h4>
    <div class="check-grid">
      <label>复测人员<input name="surveyor" required placeholder="不能是 ${escapeHtml(observation.owner)}"></label>
      <label>复测声级(dB)<input name="soundLevel" type="number" step="0.1" required></label>
      <label>复测时间<input name="at" type="datetime-local"></label>
      <button>提交复测</button>
    </div>
  </form>`;
}

function renderSoundCard(observation) {
  const site = findSite(observation.siteId);
  const open = observation.status === '观察中';
  const waited = fmtDuration(waitingMs(observation));
  const remaining = open ? checklistEntries(observation, site).filter((entry) => !entry.done).length : 0;
  const headBadge = open
    ? `<span class="pill bad">观察中 · 还差 ${remaining} 项</span>`
    : `<span class="pill ok">已恢复</span>`;
  return `<article class="card sound-card ${open ? 'is-open' : ''}">
    <div class="card-head">
      <h3>${escapeHtml(siteLabel(site))}</h3>
      ${headBadge}
    </div>
    <div class="meta">处理人：<strong>${escapeHtml(observation.owner)}</strong>（首次上报人） · 等待时长 <strong>${waited}</strong> · 样点限值 ${escapeHtml(site?.soundLimit ?? '-')} dB</div>
    <div class="detail">
      <div>峰值<br><strong>${escapeHtml(observation.peak ?? '-')} dB</strong></div>
      <div>上报次数<br><strong>${escapeHtml(observation.reportCount)}</strong></div>
      <div>建立时间<br><strong>${fmtDate(observation.openedAt || observation.createdAt)}</strong></div>
    </div>
    ${open ? checklist(observation, site) : `<p class="meta">恢复于 ${fmtDate(observation.recoveredAt)}</p>`}
    ${reportsHtml(observation)}
    ${confirmationsHtml(observation)}
    ${checkForm(observation)}
    ${historyHtml(observation, 8)}
  </article>`;
}

function renderSoundView(view) {
  const all = [...(state.db[view.collection] || [])];
  const open = all
    .filter((item) => item.status === '观察中')
    .sort((a, b) => waitingMs(a) - waitingMs(b) || new Date(a.openedAt) - new Date(b.openedAt));
  const closed = all
    .filter((item) => item.status !== '观察中')
    .sort((a, b) => new Date(b.recoveredAt || b.updatedAt) - new Date(a.recoveredAt || a.updatedAt));
  return `<section class="view" id="${view.id}">
    ${renderStats()}
    <div class="panel">
      <h2>${escapeHtml(view.listTitle)}</h2>
      <p class="meta">${escapeHtml(view.description || '')}</p>
      <div class="list">
        ${open.length ? open.map(renderSoundCard).join('') : '<div class="empty">暂无等待恢复的观察单</div>'}
        ${closed.length ? `<h3 class="sub-title">已恢复履历</h3>${closed.map(renderSoundCard).join('')}` : ''}
      </div>
    </div>
  </section>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view" id="${view.id}">
    ${renderStats()}
    <div class="panel"><h2>${escapeHtml(view.focusTitle)}</h2><div class="list">${items.length ? items.map((item) => renderCard(item, source.collection, cardView)).join('') : '<div class="empty">暂无重点事项</div>'}</div></div>
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions"><button>${escapeHtml(view.submitLabel || '保存')}</button></div>
      </form>
      <div class="panel">
        <h2>${escapeHtml(view.listTitle)}</h2>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">全部状态</option>
            ${statusOptions.map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderList(view)}</div>
      </div>
    </div>
  </section>`;
}

function render() {
  $('#title').textContent = state.config.title;
  document.title = state.config.title;
  $('#lede').textContent = state.config.lede;
  $('#main').innerHTML = state.config.views
    .map((view) => {
      if (view.type === 'sound') return renderSoundView(view);
      if (view.type === 'dashboard') return renderDashboardView(view);
      return renderCrudView(view);
    })
    .join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load(switchToSound) {
  state.db = await api('/api/db');
  render();
  if (switchToSound) setTab('sound');
}

function soundEventMessage(result) {
  const event = result?.soundEvent;
  if (!event) return '';
  if (event.type === 'created') return `峰值超限，已建立观察单：${event.observation.id}`;
  if (event.type === 'updated') return `同一样点仍在观察，已累加至第 ${event.observation.reportCount} 次上报`;
  if (event.type === 'rejudged-recovered') return '按新值重判通过，观察单已恢复闭环';
  if (event.type === 'rejudged-open') return '按新值重判后仍超限，继续观察';
  if (event.type === 'limit-revised') {
    const list = event.results || [];
    if (!list.length) return '限值已修订（当前无未结束观察）';
    const recovered = list.filter((entry) => entry.type === 'rejudged-recovered').length;
    return recovered ? `限值已修订，${recovered} 张观察单重判恢复` : '限值已修订，未结束观察仍超限';
  }
  return '';
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const amend = event.target.closest('[data-amend]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
    } catch (error) {
      toast(error.message);
    }
  }
  if (amend) {
    const current = state.db[amend.dataset.collection]?.find((item) => item.id === amend.dataset.id);
    const raw = window.prompt(`${amend.dataset.label}${amend.dataset.hint ? `\n${amend.dataset.hint}` : ''}`, current?.[amend.dataset.amend] ?? '');
    if (raw === null) return;
    const value = amend.dataset.type === 'number' ? Number(raw) : raw;
    if (amend.dataset.type === 'number' && !Number.isFinite(value)) {
      toast('请输入有效数值');
      return;
    }
    try {
      const result = await api(`/api/${amend.dataset.collection}/${amend.dataset.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ [amend.dataset.amend]: value })
      });
      await load(amend.dataset.collection === 'sites' || amend.dataset.amend === 'soundLevel');
      toast(soundEventMessage(result) || '已修订');
    } catch (error) {
      toast(error.message);
    }
  }
});

document.addEventListener('input', (event) => {
  const view = state.config.views.find((entry) => entry.id && (event.target.id === `search-${entry.id}` || event.target.id === `status-${entry.id}`));
  if (view) $(`#list-${view.id}`).innerHTML = renderList(view);
});

document.addEventListener('submit', async (event) => {
  const createForm = event.target.closest('[data-create]');
  const checkForm = event.target.closest('[data-sound-check]');

  if (checkForm) {
    event.preventDefault();
    const form = checkForm;
    const payload = Object.fromEntries(new FormData(form).entries());
    payload.soundLevel = Number(payload.soundLevel);
    if (payload.at) payload.at = new Date(payload.at).toISOString();
    else delete payload.at;
    try {
      await api(`/api/sound-observations/${form.dataset.soundCheck}/checks`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await load();
      setTab('sound');
      toast('复测合格，观察单已恢复');
    } catch (error) {
      // 409 时不合格复测仍已留痕，刷新后展示，再提示原因
      await load();
      setTab('sound');
      toast(error.message);
    }
    return;
  }

  if (!createForm) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === createForm.dataset.view);
  try {
    const result = await api(`/api/${createForm.dataset.create}`, {
      method: 'POST',
      body: JSON.stringify(values(createForm, view))
    });
    createForm.reset();
    await load(Boolean(result?.soundEvent && result.soundEvent.type !== 'within-limit'));
    toast(soundEventMessage(result) || '已保存');
  } catch (error) {
    toast(error.message);
  }
});

$('#refreshBtn').addEventListener('click', () => load().then(() => toast('已刷新')));

async function boot() {
  state.config = await api('/api/config');
  renderTabs();
  await load();
}

boot().catch((error) => toast(error.message));
