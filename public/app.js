const state = {
  config: null,
  db: {},
  console: null,
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

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 1800);
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

// 通用表单字段；staff 用 datalist，既可从名单选也可临时录入。
function formField(field) {
  const required = field.required ? 'required' : '';
  const wide = field.wide ? 'wide' : '';
  const help = field.help ? `<small>${escapeHtml(field.help)}</small>` : '';
  const valueAttr = field.value !== undefined ? `value="${escapeHtml(field.value)}"` : '';
  if (field.type === 'textarea') {
    return `<label class="${wide}">${field.label}<textarea name="${field.name}" ${required}>${escapeHtml(field.value || '')}</textarea>${help}</label>`;
  }
  if (field.type === 'select') {
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${field.options.map((option) => `<option ${option === field.value ? 'selected' : ''}>${escapeHtml(option)}</option>`).join('')}</select>${help}</label>`;
  }
  if (field.type === 'relation') {
    const items = state.db[field.collection] || [];
    return `<label class="${wide}">${field.label}<select name="${field.name}" ${required}>${optionList(items, field.labelFields)}</select>${help}</label>`;
  }
  if (field.type === 'staff') {
    const staff = state.console?.staff || [];
    return `<label class="${wide}">${field.label}<input list="staff-list" name="${field.name}" ${valueAttr} ${required} placeholder="选择或输入姓名">
      <datalist id="staff-list">${staff.map((name) => `<option value="${escapeHtml(name)}">`).join('')}</datalist>${help}</label>`;
  }
  const step = field.step !== undefined ? `step="${field.step}"` : '';
  return `<label class="${wide}">${field.label}<input type="${field.type || 'text'}" ${step} name="${field.name}" ${valueAttr} ${required}>${help}</label>`;
}

function pill(value, tone = '') {
  return `<span class="pill ${tone}">${escapeHtml(value || '-')}</span>`;
}

function toneFor(value) {
  return state.config.tones?.[value] || '';
}

function historyHtml(item) {
  const history = item.history || [];
  if (!history.length) return '';
  return `<div class="history">${history.slice(0, 6).map((entry) => `
    <div class="history-item"><span>${fmtDate(entry.at)}</span><span>${escapeHtml(entry.action)}${entry.note ? '：' + escapeHtml(entry.note) : ''}</span></div>
  `).join('')}</div>`;
}

function values(form, view) {
  const payload = Object.fromEntries(new FormData(form).entries());
  for (const field of view.fields || []) {
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

// 普通巡测卡片：流程按钮按状态收敛——异常只能去处置台，不能就地标已复查。
function renderCard(item, collection, view) {
  const title = view.titleFields.map((field) => item[field]).filter(Boolean).join(' / ') || item.id;
  const statusValue = item[view.statusField];
  const relation = view.relation ? `<div class="meta">${escapeHtml(relationLabel(view.relation, item[view.relation.localKey]))}</div>` : '';
  const details = (view.detailFields || []).map((field) => {
    const raw = item[field.name];
    const value = field.type === 'relation' ? relationLabel(field, raw) : raw;
    return `<div>${escapeHtml(field.label)}<br><strong>${escapeHtml(value || '-')}</strong></div>`;
  }).join('');
  const summary = (view.summaryFields || []).map((field) => item[field]).filter(Boolean).join(' · ');
  let actions = state.config.actions.filter((action) => action.collection === collection);
  if (collection === 'surveys' && item.status !== '正常') actions = actions.filter((action) => action.command !== 'alert');
  const buttons = actions
    .map((action) => `<button class="${action.danger ? 'danger' : 'ghost'}" data-command="${action.command || 'action'}" data-action="${action.id}" data-id="${item.id}">${escapeHtml(action.label)}</button>`)
    .join('');
  return `<article class="card">
    <div class="card-head"><h3>${escapeHtml(title)}</h3>${statusValue ? pill(statusValue, toneFor(statusValue)) : ''}</div>
    ${relation}
    ${summary ? `<p>${escapeHtml(summary)}</p>` : ''}
    ${details ? `<div class="detail">${details}</div>` : ''}
    ${item.reviewNote ? `<p class="meta">${escapeHtml(item.reviewNote)}</p>` : ''}
    ${buttons ? `<div class="actions">${buttons}${collection === 'surveys' && item.status !== '正常' ? `<button class="ghost" data-goto="console">去处置台</button>` : ''}</div>` : ''}
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
  return items.length ? items.map((item) => renderCard(item, collection, view)).join('') : `<div class="empty">暂无${escapeHtml(state.config.collections[collection]?.label || collection)}</div>`;
}

function renderDashboardView(view) {
  const source = view.focus;
  let items = [...(state.db[source.collection] || [])];
  if (source.field) items = items.filter((item) => source.values.includes(item[source.field]));
  items = items.slice(0, source.limit || 8);
  const cardView = state.config.views.find((entry) => entry.collection === source.collection) || source;
  return `<section class="view active" id="${view.id}">
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

// ————— 处置台 —————

function rangeText(check) {
  return `${fmtNum(check.min)}~${fmtNum(check.max)}${check.unit}`;
}

function fmtNum(value) {
  if (value === null || value === undefined) return '-';
  return String(Number(Number(value).toFixed(2)));
}

function renderChecks(checks) {
  return `<div class="checks">${checks.map((check) => {
    if (check.value === null) {
      return `<div class="check missing"><span>${escapeHtml(check.label)}</span><strong>未填</strong><em>允许 ${rangeText(check)}</em></div>`;
    }
    return `<div class="check ${check.inRange ? 'ok' : 'bad'}">
      <span>${escapeHtml(check.label)}</span>
      <strong>${fmtNum(check.value)}${check.unit}</strong>
      <em>${check.inRange ? '✓ 在范围内' : `✗ 允许 ${rangeText(check)}`}</em>
    </div>`;
  }).join('')}</div>`;
}

function renderConsoleRow(row) {
  const { survey, site } = row;
  const siteLabel = site ? [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ') : '未关联样点';
  const badges = [
    pill(row.stage, toneFor(row.stage)),
    row.overdue ? pill('已逾期', 'bad') : '',
    survey.review?.passed === false ? pill('上次退回', 'bad') : ''
  ].join(' ');

  const missing = row.missing.length
    ? `<div class="missing-line">待补：${row.missing.map((item) => `<span class="tag">${escapeHtml(item)}</span>`).join('')}</div>`
    : '<div class="missing-line ok-line">资料齐备，可提交复查</div>';

  const lastReview = survey.review ? `
    <div class="last-review ${survey.review.passed ? 'ok' : 'bad'}">
      ${survey.review.passed ? '上次复查：通过' : `上次复查退回：${row.exceeded.length ? escapeHtml(row.exceeded.join('；')) : '数据超限'}`}
      <span class="meta">（${fmtDate(survey.review.at)} · ${escapeHtml(survey.review.submitter)}）</span>
    </div>` : '';

  const buttons = [];
  if (row.stage === '待派单') {
    buttons.push(`<button data-modal="dispatch" data-id="${survey.id}">派单</button>`);
  } else {
    buttons.push(`<button class="ghost" data-modal="reassign" data-id="${survey.id}">改派</button>`);
    buttons.push(`<button data-modal="submit" data-id="${survey.id}">提交复查</button>`);
  }
  if (site) buttons.push(`<button class="ghost" data-modal="baseline" data-site-id="${site.id}">调整基准</button>`);

  return `<article class="card console-card">
    <div class="card-head">
      <h3>${escapeHtml(siteLabel)}</h3>
      <div class="badges">${badges}</div>
    </div>
    <div class="meta">巡测：${escapeHtml(survey.surveyor || '-')} · ${escapeHtml(survey.date || '-')}${survey.disturbance ? ' · ' + escapeHtml(survey.disturbance) : ''}</div>
    <div class="owner-line">
      <span>当前处置人：<strong>${escapeHtml(row.assignee || '未指派')}</strong></span>
      <span>复查期限：<strong class="${row.overdue ? 'overdue' : ''}">${escapeHtml(row.reviewDueAt || '未设定')}</strong></span>
    </div>
    ${missing}
    <div class="meta">按当前样点基准比对（温度±${state.console.tolerances.temp}℃ / 湿度±${state.console.tolerances.humidity}% / CO2±${state.console.tolerances.co2}ppm）：</div>
    ${row.hasReview ? renderChecks(row.latestChecks) : `<div class="meta">登记读数（参考）：</div>${renderChecks(row.initialChecks)}`}
    ${lastReview}
    <div class="actions">${buttons.join('')}</div>
    ${historyHtml(survey)}
  </article>`;
}

function renderConsoleView(view) {
  const data = state.console;
  const s = data?.summary;
  const counts = s
    ? `<div class="stats">
        <div class="stat"><span>待派单</span><strong>${s.todo}</strong></div>
        <div class="stat"><span>处理中</span><strong>${s.doing}</strong></div>
        <div class="stat"><span>复查退回</span><strong>${s.returned}</strong></div>
        <div class="stat"><span>已逾期</span><strong class="${s.overdue ? 'overdue' : ''}">${s.overdue}</strong></div>
      </div>`
    : '';
  const rows = s?.rows || [];
  return `<section class="view" id="${view.id}">
    ${counts}
    <div class="panel">
      <h2>${escapeHtml(view.listTitle)}</h2>
      <p class="meta">登记异常后在此派单（指定处置人与复查期限）；改派须写明原因；复查由当前处置人或值班负责人提交，三项全部在基准允许范围内才通过。</p>
      <div class="list">${rows.length ? rows.map(renderConsoleRow).join('') : '<div class="empty">暂无待处置异常</div>'}</div>
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
      if (view.type === 'console') return renderConsoleView(view);
      return renderCrudView(view);
    })
    .join('');
  setTab(state.activeTab || state.config.views[0].id);
}

async function load() {
  const [db, summary] = await Promise.all([api('/api/db'), api('/api/console/summary')]);
  state.db = db;
  state.console = summary;
  render();
}

// ————— 弹窗 —————

function closeModal() {
  $('#modal').classList.remove('show');
  $('#modal').innerHTML = '';
}

function openModal(formId, options = {}) {
  const def = state.config.consoleForms[formId];
  if (!def) return;
  const fields = def.fields.map((field) => ({ ...field, value: options.values?.[field.name] ?? field.value }));
  const hint = def.hint ? `<p class="modal-hint">${escapeHtml(def.hint)}</p>` : '';
  $('#modal').innerHTML = `
    <div class="modal-backdrop" data-close></div>
    <div class="modal-box panel">
      <div class="card-head"><h2>${escapeHtml(def.title)}</h2><button class="ghost" data-close type="button">×</button></div>
      ${hint}
      <form data-modal-form="${formId}" data-id="${options.id || ''}" data-site-id="${options.siteId || ''}">
        <div class="form-grid">${fields.map(formField).join('')}</div>
        <div class="actions"><button type="submit">${escapeHtml(def.submitLabel || '提交')}</button><button type="button" class="ghost" data-close>取消</button></div>
      </form>
    </div>`;
  $('#modal').classList.add('show');
}

const MODAL_ENDPOINT = {
  dispatch: (id) => `/api/console/dispatch/${id}`,
  reassign: (id) => `/api/console/reassign/${id}`,
  submit: (id) => `/api/console/submit/${id}`,
  baseline: (id, siteId) => `/api/sites/${siteId}/baseline`
};

document.addEventListener('click', async (event) => {
  if (event.target.closest('[data-close]')) return closeModal();

  const goto = event.target.closest('[data-goto]');
  if (goto) {
    setTab(goto.dataset.goto);
    return;
  }

  const modalBtn = event.target.closest('[data-modal]');
  if (modalBtn) {
    const kind = modalBtn.dataset.modal;
    if (kind === 'baseline') {
      const site = state.db.sites?.find((entry) => entry.id === modalBtn.dataset.siteId);
      openModal('baseline', {
        siteId: modalBtn.dataset.siteId,
        values: {
          baselineTemp: site?.baselineTemp,
          baselineHumidity: site?.baselineHumidity,
          baselineCo2: site?.baselineCo2
        }
      });
    } else {
      // 提交复查默认带出登记读数与当前处置人，便于核对后再填。
      const survey = state.db.surveys?.find((entry) => entry.id === modalBtn.dataset.id);
      const values = {};
      if (kind === 'submit' && survey) {
        values.submitter = survey.assignee || '';
        values.temperature = survey.temperature;
        values.humidity = survey.humidity;
        values.co2 = survey.co2;
      }
      openModal(kind, { id: modalBtn.dataset.id, values });
    }
    return;
  }

  const tab = event.target.closest('.tab');
  const action = event.target.closest('[data-action]');
  if (tab) setTab(tab.dataset.tab);
  if (action) {
    try {
      const command = action.dataset.command;
      if (command === 'alert') {
        await api(`/api/console/alert/${action.dataset.id}`, { method: 'POST' });
      } else {
        await api(`/api/action/${action.dataset.action}/${action.dataset.id}`, { method: 'POST' });
      }
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
  const modalForm = event.target.closest('[data-modal-form]');
  if (modalForm) {
    event.preventDefault();
    const kind = modalForm.dataset.modalForm;
    const def = state.config.consoleForms[kind];
    const payload = values(modalForm, def);
    const url = MODAL_ENDPOINT[kind](modalForm.dataset.id, modalForm.dataset.siteId);
    try {
      await api(url, { method: 'POST', body: JSON.stringify(payload) });
      closeModal();
      await load();
      toast(kind === 'submit' ? '复查已提交' : '已提交');
    } catch (error) {
      toast(error.message);
    }
    return;
  }

  const form = event.target.closest('[data-create]');
  if (!form) return;
  event.preventDefault();
  const view = state.config.views.find((entry) => entry.id === form.dataset.view);
  try {
    await api(`/api/${form.dataset.create}`, { method: 'POST', body: JSON.stringify(values(form, view)) });
    form.reset();
    await load();
    toast('已保存');
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
