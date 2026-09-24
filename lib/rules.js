'use strict';

// 处置台领域规则：纯函数，不做任何 IO，方便单测与复用。
// 三件事在这里判定：
//   1. 派单：异常登记后指定处置人 + 复查期限；
//   2. 改派：必须写明原因，原处置人留痕；
//   3. 复查提交：温度 / 湿度 / CO2 三项都在样点基准允许范围内才通过，
//      任一项超出即退回并保留数据。基准调整后，对未完成复查按新范围重判。

const STAGES = {
  NORMAL: '正常',
  TODO: '待派单',
  DOING: '处理中',
  RETURNED: '复查退回',
  DONE: '已复查'
};

const METRICS = [
  { key: 'temperature', baseline: 'baselineTemp', label: '温度', unit: '℃', tolerance: 'temp' },
  { key: 'humidity', baseline: 'baselineHumidity', label: '湿度', unit: '%', tolerance: 'humidity' },
  { key: 'co2', baseline: 'baselineCo2', label: 'CO2', unit: 'ppm', tolerance: 'co2' }
];

const OPEN_STAGES = [STAGES.TODO, STAGES.DOING, STAGES.RETURNED];

function isBlank(value) {
  return value === undefined || value === null || String(value).trim() === '';
}

function toNumber(value) {
  if (isBlank(value)) return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

// 允许范围 = 基准值 ± 允许偏差（偏差在 project.config.js 的 tolerances 中维护）。
function baselineRange(baselineValue, tolerance) {
  const center = Number(baselineValue);
  if (!Number.isFinite(center) || !Number.isFinite(tolerance)) return null;
  return { min: center - tolerance, max: center + tolerance };
}

function getSiteBaselineRanges(site, config) {
  const tolerances = config.tolerances || {};
  const ranges = {};
  for (const metric of METRICS) {
    ranges[metric.key] = baselineRange(site?.[metric.baseline], tolerances[metric.tolerance]);
  }
  return ranges;
}

function evaluate(readings, site, config) {
  const ranges = getSiteBaselineRanges(site, config);
  const checks = METRICS.map((metric) => {
    const value = toNumber(readings?.[metric.key]);
    const range = ranges[metric.key];
    let inRange = false;
    if (value !== null && range) inRange = value >= range.min && value <= range.max;
    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      value,
      min: range ? range.min : null,
      max: range ? range.max : null,
      inRange
    };
  });
  const violations = checks.filter((check) => check.value === null || !check.inRange);
  return { checks, violations, passed: violations.length === 0 };
}

// 给控制台列表用的判定：缺哪项 / 是否超基准（始终用最新基准重算）。
// 只看“复查读数”；尚未提交复查时三项都算缺，不拿登记读数顶替。
function evaluateAgainstBaseline(survey, site, config) {
  const result = evaluate(survey.review?.readings || {}, site, config);
  const missing = result.checks.filter((check) => check.value === null).map((check) => check.label);
  const exceeded = result.checks
    .filter((check) => check.value !== null && !check.inRange)
    .map((check) => `${check.label} ${check.value}${check.unit}（允许 ${fmt(check.min)}~${fmt(check.max)}）`);
  return { ...result, missing, exceeded };
}

// 登记时的原始读数，按当前基准做参考比对（不作为复查结论）。
function evaluateInitialAgainstBaseline(survey, site, config) {
  return evaluate(survey, site, config);
}

function fmt(value) {
  return value === null || value === undefined ? '-' : String(Number(value.toFixed(2)));
}

function stamp(action, note, extra = {}) {
  return { at: new Date().toISOString(), action, note: note || '', ...extra };
}

// 复查期限按“当天 23:59:59”计，避免登记当天就被误判逾期。
function isOverdue(survey, now = new Date()) {
  if (!survey.reviewDueAt || !OPEN_STAGES.includes(stageOf(survey))) return false;
  const due = new Date(`${survey.reviewDueAt}T23:59:59`);
  return due.getTime() < now.getTime();
}

function stageOf(survey) {
  return survey.status || STAGES.NORMAL;
}

// 遗留数据兼容：早期异常只有“异常待复查”，没有处置人/期限。
function normalizeSurvey(survey) {
  const next = {
    assignee: '',
    reviewDueAt: '',
    reviewNote: '',
    review: null,
    ...survey
  };
  if (next.status === '异常待复查') next.status = isBlank(next.assignee) ? STAGES.TODO : STAGES.DOING;
  return next;
}

function isDutyLead(name, config) {
  return (config.dutyLeads || []).includes(name);
}

// ① 标记异常：进入待派单（登记与派单分离，登记后必须派单）。
function markAlert(db, survey, config) {
  const site = db.sites?.find((entry) => entry.id === survey.siteId);
  if (!site) return { error: '未找到关联样点，无法登记异常' };
  if (OPEN_STAGES.includes(stageOf(survey)) || stageOf(survey) === STAGES.DONE) {
    return { error: '该巡测已在复查流程中' };
  }
  survey.status = STAGES.TODO;
  survey.assignee = '';
  survey.reviewDueAt = '';
  survey.review = null;
  survey.reviewNote = '';
  survey.updatedAt = now();
  survey.history = survey.history || [];
  survey.history.unshift(stamp('标记异常', '登记异常，等待派单'));
  return { item: survey, site };
}

// ② 派单：指定处置人 + 复查期限。
function dispatch(db, survey, payload, config) {
  const stage = stageOf(survey);
  if (stage !== STAGES.TODO) return { error: '只有待派单的异常可以派单' };
  const assignee = String(payload.assignee || '').trim();
  const reviewDueAt = String(payload.reviewDueAt || '').trim();
  if (!assignee) return { error: '请指定处置人' };
  if (!reviewDueAt) return { error: '请填写复查期限' };

  const site = db.sites?.find((entry) => entry.id === survey.siteId);
  survey.assignee = assignee;
  survey.reviewDueAt = reviewDueAt;
  survey.status = STAGES.DOING;
  survey.updatedAt = now();
  survey.history = survey.history || [];
  survey.history.unshift(
    stamp('派单', `处置人：${assignee}；复查期限：${reviewDueAt}`, { by: String(payload.operator || '').trim(), to: assignee })
  );
  return { item: survey, site };
}

// ③ 改派：必须写明原因，记录原处置人与新处置人。
function reassign(db, survey, payload, config) {
  const stage = stageOf(survey);
  if (stage !== STAGES.DOING && stage !== STAGES.RETURNED) return { error: '当前状态不能改派' };
  const to = String(payload.assignee || '').trim();
  const reason = String(payload.reason || '').trim();
  if (!to) return { error: '请指定新的处置人' };
  if (!reason) return { error: '改派必须写明原因' };
  if (to === survey.assignee) return { error: '新处置人与当前处置人相同' };

  const from = survey.assignee;
  survey.assignee = to;
  survey.status = STAGES.DOING;
  survey.updatedAt = now();
  survey.history = survey.history || [];
  survey.history.unshift(
    stamp('改派', `原处置人：${from || '无'} → 新处置人：${to}；原因：${reason}`, { by: String(payload.operator || '').trim(), from, to, reason })
  );
  return { item: survey };
}

// ④ 提交复查：仅当前处置人或值班负责人可提交；三项全部在基准允许范围内才通过。
function submitReview(db, survey, payload, config) {
  const stage = stageOf(survey);
  if (stage !== STAGES.DOING && stage !== STAGES.RETURNED) return { error: '当前状态不能提交复查' };

  const submitter = String(payload.submitter || '').trim();
  if (!submitter) return { error: '请填写提交人' };
  if (submitter !== survey.assignee && !isDutyLead(submitter, config)) {
    return { error: '只有当前处置人或值班负责人可以提交复查' };
  }

  const readings = {
    temperature: toNumber(payload.temperature),
    humidity: toNumber(payload.humidity),
    co2: toNumber(payload.co2)
  };
  const missingMetrics = METRICS.filter((metric) => readings[metric.key] === null).map((metric) => metric.label);
  if (missingMetrics.length) return { error: `缺少复查数据：${missingMetrics.join('、')}` };

  const site = db.sites?.find((entry) => entry.id === survey.siteId);
  if (!site) return { error: '未找到关联样点，无法比对基准' };

  // 关键：始终拿当前样点基准判定。基准调整后，未完成复查自然按新范围重判。
  const verdict = evaluate(readings, site, config);
  const at = now();
  survey.review = {
    at,
    submitter,
    readings,
    baselineSnapshot: {
      baselineTemp: site.baselineTemp,
      baselineHumidity: site.baselineHumidity,
      baselineCo2: site.baselineCo2
    },
    checks: verdict.checks,
    passed: verdict.passed
  };

  survey.history = survey.history || [];
  if (verdict.passed) {
    survey.status = STAGES.DONE;
    survey.reviewNote = `复查通过（${submitter}）`;
    survey.history.unshift(stamp('复查通过', `三项均在基准允许范围内（提交人：${submitter}）`, { by: submitter }));
  } else {
    survey.status = STAGES.RETURNED;
    const detail = verdict.violations
      .map((check) => `${check.label} ${check.value}${check.unit}，允许 ${fmt(check.min)}~${fmt(check.max)}${check.unit}`)
      .join('；');
    survey.reviewNote = `复查退回：${detail}`;
    survey.history.unshift(stamp('复查退回', `${detail}（提交人：${submitter}），数据已留存，限期整改后重新复查`, { by: submitter }));
  }
  survey.updatedAt = at;
  return { item: survey, site, verdict };
}

function surveySite(db, survey) {
  return db.sites?.find((entry) => entry.id === survey.siteId) || null;
}

// 控制台列表：谁在处理、还缺哪项、是否逾期/退回。
function consoleRows(db, config) {
  const surveys = (db.surveys || []).map(normalizeSurvey);
  return surveys
    .filter((survey) => OPEN_STAGES.includes(stageOf(survey)))
    .map((survey) => {
      const site = surveySite(db, survey);
      const latest = evaluateAgainstBaseline(survey, site, config);
      const stage = stageOf(survey);
      const missing = [];
      if (!survey.assignee) missing.push('处置人');
      if (!survey.reviewDueAt) missing.push('复查期限');
      if (stage !== STAGES.TODO) missing.push(...latest.missing.map((label) => `复查${label}`));

      const nextAction = stage === STAGES.TODO ? 'dispatch' : 'submit';

      return {
        survey,
        site,
        stage,
        overdue: isOverdue(survey),
        assignee: survey.assignee || '',
        reviewDueAt: survey.reviewDueAt || '',
        missing,
        latestChecks: latest.checks,
        exceeded: latest.exceeded,
        initialChecks: evaluateInitialAgainstBaseline(survey, site, config).checks,
        hasReview: Boolean(survey.review),
        canReassign: stage === STAGES.DOING || stage === STAGES.RETURNED,
        canSubmit: stage === STAGES.DOING || stage === STAGES.RETURNED,
        lastReview: survey.review || null
      };
    })
    .sort((a, b) => {
      const rank = { [STAGES.TODO]: 0, [STAGES.RETURNED]: 1, [STAGES.DOING]: 2 };
      if (rank[a.stage] !== rank[b.stage]) return rank[a.stage] - rank[b.stage];
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      return new Date(b.survey.updatedAt || 0) - new Date(a.survey.updatedAt || 0);
    });
}

function consoleSummary(db, config) {
  const rows = consoleRows(db, config);
  return {
    todo: rows.filter((row) => row.stage === STAGES.TODO).length,
    doing: rows.filter((row) => row.stage === STAGES.DOING).length,
    returned: rows.filter((row) => row.stage === STAGES.RETURNED).length,
    overdue: rows.filter((row) => row.overdue).length,
    rows
  };
}

// 值班负责人 + 有处置记录的人，供前端下拉。
function staffList(db, config) {
  const names = new Set(config.dutyLeads || []);
  for (const survey of db.surveys || []) {
    if (survey.assignee) names.add(survey.assignee);
    if (survey.surveyor) names.add(survey.surveyor);
  }
  return [...names].filter(Boolean);
}

function now() {
  return new Date().toISOString();
}

module.exports = {
  STAGES,
  METRICS,
  OPEN_STAGES,
  baselineRange,
  evaluate,
  evaluateAgainstBaseline,
  evaluateInitialAgainstBaseline,
  normalizeSurvey,
  isOverdue,
  stageOf,
  isDutyLead,
  markAlert,
  dispatch,
  reassign,
  submitReview,
  consoleRows,
  consoleSummary,
  staffList,
  surveySite
};
