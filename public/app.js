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

// datetime-local 控件需要 YYYY-MM-DDTHH:mm 格式
function fmtLocalValue(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtWait(from) {
  const ms = Date.now() - new Date(from).getTime();
  if (ms <= 0) return '刚开单';
  const mins = Math.max(1, Math.round(ms / 60000));
  if (mins < 60) return `已等待 ${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const rest = mins % 60;
  if (hours < 48) return rest ? `已等待 ${hours} 小时 ${rest} 分` : `已等待 ${hours} 小时`;
  return `已等待 ${Math.round(hours / 24)} 天`;
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
    throw new Error(body.error || '请求失败');
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

function relationLabel(relation, id) {
  const item = state.db[relation.collection]?.find((entry) => entry.id === id);
  if (!item) return '未关联';
  return relation.labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
}

function siteLabel(siteId) {
  const site = state.db.sites?.find((entry) => entry.id === siteId);
  if (!site) return '未关联样点';
  return ['cave', 'zone', 'pointCode'].map((field) => site[field]).filter(Boolean).join(' / ');
}

function optionList(items, labelFields) {
  return items.map((item) => {
    const label = labelFields.map((field) => item[field]).filter(Boolean).join(' / ');
    return `<option value="${item.id}">${escapeHtml(label)}</option>`;
  }).join('');
}

function formField(field) {
  const required = field.required ? 'required' : '';
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
  const inputType = field.type === 'datetime' ? 'datetime-local' : (field.type || 'text');
  return `<label class="${field.wide ? 'wide' : ''}">${field.label}<input type="${inputType}" name="${field.name}" ${required}></label>`;
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

// 新增时带上默认值；修订时只提交表单内字段，避免覆盖状态
function payloadFrom(form, view, applyDefaults) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields) {
    if (field.type === 'number') payload[field.name] = Number(payload[field.name] || 0);
  }
  return applyDefaults ? { ...view.defaults, ...payload } : payload;
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

function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : (field.type === 'datetime' ? fmtDate(raw) : raw);
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  const actions = state.config.actions
    .filter((action) => action.collection === collection)
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  const edit = view.editable ? `<button class="ghost" data-edit data-collection="${collection}" data-id="${item.id}">修订</button>` : '';
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${actions || edit ? `<div class="actions">${actions}${edit}</div>` : ''}
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

// ============ 声环境观察单 ============

function waitAnchor(obs) {
  // 已有人接单后，等待时长从首次确认算起；否则从开单算起
  return obs.confirmations && obs.confirmations.length ? obs.confirmations[0].at : obs.openedAt;
}

function sortByWait(list) {
  return [...list].sort((a, b) => new Date(waitAnchor(a)) - new Date(waitAnchor(b)));
}

function renderObsCard(obs, compact = false) {
  const remaining = Number(obs.remaining || 0);
  const assignee = obs.assignee || '待其他巡测员接单';
  const confirmations = (obs.confirmations || []).map((conf, index) => `
    <div class="history-item"><span>${fmtDate(conf.at)}</span><span>第 ${index + 1} 次确认：${escapeHtml(conf.surveyor)} 测得 ${escapeHtml(conf.soundLevel)} dB（限值 ${escapeHtml(obs.noiseLimit)} dB）</span></div>
  `).join('');
  const gapHint = remaining === 1 ? '<div class="meta">第 2 次确认须由同一巡测员完成，且与首次间隔不少于 2 小时</div>' : '';
  return `<article class="card obs-card ${remaining > 0 ? 'open' : 'closed'}">
    <div class="card-head">
      <h3>${escapeHtml(siteLabel(obs.siteId))}</h3>
      ${pill(obs.status, toneFor(obs.status))}
    </div>
    <div class="meta">开单人：${escapeHtml(obs.opener)} · 开单：${fmtDate(obs.openedAt)}${obs.closedAt ? ` · 结束：${fmtDate(obs.closedAt)}` : ''}</div>
    <div class="detail">
      <div>限值(dB)<br><strong>${escapeHtml(obs.noiseLimit)}</strong></div>
      <div>峰值(dB)<br><strong>${escapeHtml(obs.peakLevel)}</strong></div>
      <div>超限次数<br><strong>${escapeHtml(obs.reportCount)}</strong></div>
      <div>最近团队人数<br><strong>${escapeHtml(obs.teamSize ?? '-')}</strong></div>
    </div>
    ${remaining > 0 ? `
      <div class="queue-row">
        <div><span class="queue-label">处理人</span><strong>${escapeHtml(assignee)}</strong></div>
        <div><span class="queue-label">等待时长</span><strong>${escapeHtml(fmtWait(waitAnchor(obs)))}</strong></div>
        <div><span class="queue-label">还差几项</span><strong class="gap">还差 ${remaining} 项低于限值确认</strong></div>
      </div>
      ${gapHint}
      ${confirmations ? `<div class="history">${confirmations}</div>` : ''}
    ` : ''}
    ${compact ? historyHtml(obs, 3) : historyHtml(obs)}
  </article>`;
}

function renderQueueView(view) {
  const all = state.db.observations || [];
  const open = sortByWait(all.filter((item) => item.status === '观察中'));
  const closed = [...all.filter((item) => item.status !== '观察中')]
    .sort((a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt));
  return `<section class="view" id="${view.id}">
    <div class="panel queue-panel">
      <h2>${escapeHtml(view.listTitle)}</h2>
      <p class="meta rule-note">${escapeHtml(view.hint || '')}</p>
      <h3 class="subhead">${escapeHtml(view.openTitle)}（${open.length}）</h3>
      <div class="list">${open.length ? open.map((item) => renderObsCard(item)).join('') : '<div class="empty">暂无待确认观察单，声环境均已恢复</div>'}</div>
      <h3 class="subhead">${escapeHtml(view.closedTitle)}（${closed.length}）</h3>
      <div class="list">${closed.length ? closed.map((item) => renderObsCard(item, true)).join('') : '<div class="empty">暂无已结束观察单</div>'}</div>
    </div>
  </section>`;
}

function renderDashboardView(view) {
  const groups = (Array.isArray(view.focus) ? view.focus : [view.focus]).map((source) => {
    let items = [...(state.db[source.collection] || [])];
    if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
    if (source.order === 'wait') items = sortByWait(items);
    items = items.slice(0, source.limit || 8);
    const cardView = state.config.views.find((entry) => entry.collection === source.collection);
    return { source, items, cardView };
  });
  const panels = groups.map(({ source, items, cardView }) => {
    const body = items.length
      ? items.map((item) => (source.collection === 'observations' ? renderObsCard(item, true) : renderCard(item, source.collection, cardView))).join('')
      : '<div class="empty">暂无重点事项</div>';
    return `<div class="panel"><h2>${escapeHtml(source.title || view.focusTitle)}</h2><div class="list">${body}</div></div>`;
  }).join('');
  return `<section class="view active" id="${view.id}">
    ${renderStats()}
    ${panels}
  </section>`;
}

function renderCrudView(view) {
  const statusOptions = view.statusOptions || [];
  return `<section class="view" id="${view.id}">
    <div class="grid">
      <form class="panel" data-create="${view.collection}" data-view="${view.id}" id="form-${view.id}">
        <h2>${escapeHtml(view.formTitle)}</h2>
        <div class="form-grid">${view.fields.map(formField).join('')}</div>
        <div class="actions">
          <button class="submit-btn">${escapeHtml(view.submitLabel || '保存')}</button>
          <button type="button" class="ghost cancel-edit" hidden>取消修订</button>
        </div>
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
      if (view.type === 'dashboard') return renderDashboardView(view);
      if (view.type === 'queue') return renderQueueView(view);
      return renderCrudView(view);
    })
    .join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  state.db = await api('/api/db');
  render();
}

// ============ 修订（编辑）模式 ============

function enterEditMode(collection, id) {
  const view = state.config.views.find((entry) => entry.collection === collection && entry.type !== 'queue');
  const item = state.db[collection]?.find((entry) => entry.id === id);
  if (!view || !item) return;
  setTab(view.id);
  const form = $(`#form-${view.id}`);
  form.dataset.editId = id;
  for (const field of view.fields) {
    const el = form.elements[field.name];
    if (!el) continue;
    const raw = item[field.name];
    el.value = field.type === 'datetime' ? fmtLocalValue(raw) : (raw ?? '');
  }
  form.querySelector('h2').textContent = `修订${collectionLabel(collection).replace(/档案|记录/g, '')}`;
  form.querySelector('.submit-btn').textContent = '保存修订';
  form.querySelector('.cancel-edit').hidden = false;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

document.addEventListener('click', async (event) => {
  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  const edit = event.target.closest('[data-edit]');
  const cancel = event.target.closest('.cancel-edit');
  if (tab) setTab(tab.dataset.tab);
  if (cancel) {
    await load();
    toast('已退出修订');
    return;
  }
  if (edit) {
    enterEditMode(edit.dataset.collection, edit.dataset.id);
    return;
  }
  if (action) {
    try {
      await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      await load();
      toast('已更新');
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
  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  const editId = form.dataset.editId;
  try {
    let result;
    if (editId) {
      result = await api(`/api/${form.dataset.create}/${editId}`, {
        method: 'PATCH',
        body: JSON.stringify(payloadFrom(form, view, false))
      });
    } else {
      result = await api(`/api/${form.dataset.create}`, {
        method: 'POST',
        body: JSON.stringify(payloadFrom(form, view, true))
      });
    }
    form.reset();
    await load();
    toast(result?.notice || (editId ? '修订已保存，观察单已按新值重判' : '已保存'));
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
