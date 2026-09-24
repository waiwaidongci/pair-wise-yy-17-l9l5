// 处置台页面层：只负责渲染与交互，判定规则来自 /api/config，业务判定由后端 /api/desk 完成。
(function () {
  const metrics = () => state.config.handling.metrics;
  const staff = () => state.config.handling.staff;
  const leads = () => state.config.handling.dutyLeads;

  function todayStr() {
    return new Date().toLocaleDateString('en-CA');
  }

  function offsetDate(days) {
    const date = new Date();
    date.setDate(date.getDate() + days);
    return date.toLocaleDateString('en-CA');
  }

  function isOverdue(survey) {
    return survey.status !== '已复查' && survey.dueDate && survey.dueDate < todayStr();
  }

  function round(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function decimalsOf(value) {
    const text = String(value);
    return text.includes('.') ? text.split('.')[1].length : 0;
  }

  // 用样点当前基准算展示范围（与后端 rules/handling.js 同口径）
  function liveRange(metric, site) {
    const baseline = Number(site?.[metric.baseline]);
    if (!Number.isFinite(baseline)) return null;
    const decimals = Math.max(decimalsOf(baseline), decimalsOf(metric.tolerance));
    return {
      min: round(baseline - metric.tolerance, decimals),
      max: round(baseline + metric.tolerance, decimals),
      baseline,
      unit: metric.unit
    };
  }

  function siteOf(survey) {
    return state.db.sites?.find((entry) => entry.id === survey.siteId);
  }

  function siteLabel(site) {
    if (!site) return '未关联样点';
    return [site.cave, site.zone, site.pointCode].filter(Boolean).join(' / ');
  }

  // ---------- 当前值班人员 ----------

  function initOperator() {
    const select = $('#operator');
    const people = [...new Set([...staff(), ...leads()])];
    select.innerHTML = people.map((name) => {
      const tag = leads().includes(name) ? '（值班负责人）' : '';
      return `<option value="${escapeHtml(name)}">${escapeHtml(name)}${tag}</option>`;
    }).join('');
    const saved = localStorage.getItem('operator');
    select.value = saved && people.includes(saved) ? saved : staff()[0] || people[0] || '';
    select.addEventListener('change', () => {
      localStorage.setItem('operator', select.value);
      load();
    });
  }

  function currentOperator() {
    return $('#operator')?.value || '';
  }

  function canSubmit(survey) {
    const actor = currentOperator();
    return leads().includes(actor) || survey.assignee === actor;
  }

  // ---------- 指标卡片：看得出哪项合格、哪项超范围、还缺哪项 ----------

  function metricChips(survey, site) {
    const judged = survey.lastJudge?.metrics || [];
    return `<div class="metric-grid">${metrics().map((metric) => {
      const result = judged.find((entry) => entry.key === metric.name);
      const range = result || liveRange(metric, site);
      const rangeText = range ? `允许 ${range.min}~${range.max}${range.unit}` : '样点缺基准';
      if (!result) {
        return `<div class="metric pending"><strong>${escapeHtml(metric.label)}</strong><span class="miss">待复查</span><small>${rangeText}</small></div>`;
      }
      if (!result.measured) {
        return `<div class="metric bad"><strong>${escapeHtml(metric.label)}</strong><span class="miss">缺数据</span><small>${rangeText}</small></div>`;
      }
      const tone = result.ok ? 'ok' : 'bad';
      const mark = result.ok ? '合格' : `超范围（基准 ${result.baseline}${result.unit}）`;
      return `<div class="metric ${tone}"><strong>${escapeHtml(metric.label)} ${escapeHtml(result.value)}${escapeHtml(result.unit)}</strong><span>${mark}</span><small>${rangeText}</small></div>`;
    }).join('')}</div>`;
  }

  function gapLine(survey) {
    const results = survey.lastJudge?.metrics || [];
    if (survey.status === '已复查') return '';
    if (!survey.assignee) {
      return '<p class="gap bad">尚未登记处置人与复查期限</p>';
    }
    if (!results.length) {
      return `<p class="gap">待复查：${metrics().map((m) => m.label).join('、')} 三项数据均未填报</p>`;
    }
    const failed = results.filter((entry) => !entry.ok);
    if (!failed.length) {
      return '<p class="gap ok">三项数据均在新基准范围内，待当前处置人或值班负责人提交通过</p>';
    }
    const names = failed.map((entry) => entry.label).join('、');
    return `<p class="gap bad">${escapeHtml(names)} 超出允许范围，已退回，需重新测量填报</p>`;
  }

  // ---------- 操作表单 ----------

  function staffOptions(except) {
    return staff()
      .filter((name) => name !== except)
      .map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
      .join('');
  }

  function deskActions(survey) {
    if (survey.status === '已复查') return '';

    if (!survey.assignee) {
      return `<details class="inline-form" ${survey.status === '正常' ? '' : 'open'}>
        <summary class="ghost">登记处置</summary>
        <form data-desk-action="register" data-id="${survey.id}">
          <div class="form-grid">
            <label>处置人<select name="assignee" required>${staff().map((name) => `<option>${escapeHtml(name)}</option>`).join('')}</select></label>
            <label>复查期限<input type="date" name="dueDate" min="${todayStr()}" value="${offsetDate(2)}" required></label>
            <label class="wide">登记说明<textarea name="note" placeholder="异常情况与处置要求"></textarea></label>
          </div>
          <div class="actions"><button>登记并派发</button></div>
        </form>
      </details>`;
    }

    const reviewBody = canSubmit(survey)
      ? `<form data-desk-action="review" data-id="${survey.id}">
          <div class="form-grid">
            ${metrics().map((metric) => `<label>复查${escapeHtml(metric.label)}<input type="number" step="any" name="${metric.name}" required></label>`).join('')}
          </div>
          <p class="meta">三项均在样点基准允许范围内才通过；任一项超范围将退回并保留本次数据。</p>
          <div class="actions"><button>提交复查</button></div>
        </form>`
      : `<p class="gap">仅当前处置人（${escapeHtml(survey.assignee)}）或值班负责人可提交复查，请右上角切换值班人员。</p>`;

    return `<details class="inline-form">
        <summary class="ghost">改派</summary>
        <form data-desk-action="reassign" data-id="${survey.id}">
          <div class="form-grid">
            <label>改派给<select name="to" required>${staffOptions(survey.assignee)}</select></label>
            <label class="wide">改派原因（必填）<textarea name="reason" required placeholder="写明交接原因与已告知事项"></textarea></label>
          </div>
          <div class="actions"><button class="ghost">确认改派</button></div>
        </form>
      </details>
      <div class="review-box">${reviewBody}</div>`;
  }

  function assignmentHtml(survey) {
    if (survey.status === '已复查') {
      const last = survey.reviews?.[0];
      return `<div class="assign">
        <span>处置人：<strong>${escapeHtml(survey.assignee || '-')}</strong></span>
        <span>复查人：<strong>${escapeHtml(last?.by || '-')}</strong></span>
        <span>完成时间：${fmtDate(survey.closedAt)}</span>
      </div>`;
    }
    if (!survey.assignee) return '';
    const latest = survey.handover?.[0];
    const due = isOverdue(survey)
      ? `<strong class="overdue">${escapeHtml(survey.dueDate)}（已逾期）</strong>`
      : `<strong>${escapeHtml(survey.dueDate)}</strong>`;
    return `<div class="assign">
        <span>当前处置人：<strong>${escapeHtml(survey.assignee)}</strong></span>
        <span>复查期限：${due}</span>
      </div>
      ${latest ? `<div class="meta handover">最近改派：${escapeHtml(latest.from)} → ${escapeHtml(latest.to)}；原因：${escapeHtml(latest.reason)}（${fmtDate(latest.at)}）</div>` : ''}`;
  }

  function renderSurveyCard(survey) {
    const site = siteOf(survey);
    const status = survey.status || '正常';
    const title = [survey.surveyor, survey.date].filter(Boolean).join(' / ') || survey.id;
    const initial = metrics()
      .map((metric) => `${metric.label} ${survey[metric.name] ?? '-'}${metric.unit}`)
      .join(' · ');
    return `<article class="card survey-card">
      <div class="card-head">
        <h3>${escapeHtml(title)}</h3>
        ${window.pill(status, window.toneFor(status))}
      </div>
      <div class="meta">${escapeHtml(siteLabel(site))}</div>
      ${assignmentHtml(survey)}
      <div class="meta">初测：${escapeHtml(initial)}</div>
      ${metricChips(survey, site)}
      ${gapLine(survey)}
      <div class="actions desk-actions">${deskActions(survey)}</div>
      ${window.historyHtml(survey)}
    </article>`;
  }

  // ---------- 列表：谁在处理、还缺哪项 ----------

  const rank = { 复查退回: 0, 异常待复查: 1, 已复查: 2, 正常: 3 };

  function deskItems(view) {
    const query = $(`#search-${view.id}`)?.value.trim() || '';
    const status = $(`#status-${view.id}`)?.value || '';
    let items = [...(state.db.surveys || [])];
    if (status) {
      items = items.filter((item) => item.status === status);
    } else {
      items = items.filter((item) => item.status && item.status !== '正常');
    }
    if (query) {
      const q = query.toLowerCase();
      items = items.filter((item) => {
        const site = siteOf(item);
        const haystack = [
          item.surveyor, item.assignee, item.dueDate, item.reviewNote,
          site?.cave, site?.zone, site?.pointCode
        ].filter(Boolean).join(' ').toLowerCase();
        return haystack.includes(q);
      });
    }
    items.sort((a, b) => {
      const ra = rank[a.status] ?? 4;
      const rb = rank[b.status] ?? 4;
      if (ra !== rb) return ra - rb;
      if (isOverdue(a) !== isOverdue(b)) return isOverdue(a) ? -1 : 1;
      return String(a.dueDate || '').localeCompare(String(b.dueDate || ''));
    });
    return items;
  }

  function renderDeskList(view) {
    const items = deskItems(view);
    return items.length
      ? items.map(renderSurveyCard).join('')
      : '<div class="empty">暂无待处置的异常记录</div>';
  }

  function renderDeskView(view) {
    const operator = currentOperator();
    const leadTag = leads().includes(operator) ? '<span class="pill warn">值班负责人</span>' : '';
    return `<section class="view" id="${view.id}">
      <div class="panel">
        <div class="desk-head">
          <h2>${escapeHtml(view.listTitle)}</h2>
          <div class="meta">登记 → 派发处置人 → 复查填报 → 判定通过/退回 · 当前操作人：<strong>${escapeHtml(operator)}</strong> ${leadTag}</div>
        </div>
        <div class="toolbar">
          <input id="search-${view.id}" placeholder="${escapeHtml(view.searchPlaceholder || '搜索')}">
          <select id="status-${view.id}">
            <option value="">未完成 + 已复查</option>
            ${(view.statusOptions || []).map((option) => `<option>${escapeHtml(option)}</option>`).join('')}
          </select>
        </div>
        <div class="list" id="list-${view.id}">${renderDeskList(view)}</div>
      </div>
    </section>`;
  }

  // ---------- 样点基准调整入口 ----------

  function renderSiteExtras(site) {
    return `<details class="inline-form baseline-editor">
      <summary class="ghost">调整基准</summary>
      <form data-baseline="${site.id}">
        <div class="form-grid">
          ${metrics().map((metric) => `
            <label>${escapeHtml(metric.label)}基准（±${escapeHtml(metric.tolerance)}${escapeHtml(metric.unit)}）
              <input type="number" step="any" name="${metric.baseline}" value="${escapeHtml(site[metric.baseline] ?? '')}" required>
            </label>`).join('')}
        </div>
        <p class="meta">保存后，所有未完成复查的记录将按新范围重新判定，已复查记录不变。</p>
        <div class="actions"><button class="ghost">保存并重判</button></div>
      </form>
    </details>`;
  }

  // ---------- 事件 ----------

  document.addEventListener('submit', async (event) => {
    const deskForm = event.target.closest('[data-desk-action]');
    const baselineForm = event.target.closest('[data-baseline]');
    if (!deskForm && !baselineForm) return;
    event.preventDefault();

    try {
      if (baselineForm) {
        const payload = Object.fromEntries(new FormData(baselineForm).entries());
        for (const metric of metrics()) payload[metric.baseline] = Number(payload[metric.baseline]);
        payload.actor = currentOperator();
        const result = await api(`/api/sites/${baselineForm.dataset.baseline}/baseline`, {
          method: 'PATCH',
          body: JSON.stringify(payload)
        });
        await load();
        const count = result.rejudged?.length || 0;
        toast(count ? `基准已保存，${count} 条未完成复查已按新范围重判` : '基准已保存，无待重判记录');
        return;
      }

      const action = deskForm.dataset.deskAction;
      const id = deskForm.dataset.id;
      const payload = Object.fromEntries(new FormData(deskForm).entries());
      payload.actor = currentOperator();
      if (action === 'review') {
        for (const metric of metrics()) payload[metric.name] = Number(payload[metric.name]);
      }

      const result = await api(`/api/desk/${id}/${action}`, {
        method: 'POST',
        body: JSON.stringify(payload)
      });
      await load();
      if (action === 'register') toast('已登记并派发');
      if (action === 'reassign') toast('已改派，交接原因已留痕');
      if (action === 'review') toast(result.passed ? '三项均合格，复查通过' : '存在超范围项，已退回并保留数据');
    } catch (error) {
      toast(error.message);
    }
  });

  window.initOperator = initOperator;
  window.renderDeskView = renderDeskView;
  window.renderDeskList = renderDeskList;
  window.renderSurveyCard = renderSurveyCard;
  window.renderSiteExtras = renderSiteExtras;
})();
