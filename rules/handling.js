// 处置台业务规则：纯函数模块，不接触存储、HTTP 与页面。
// 允许范围 = 样点基准 ± 配置偏差（config.handling.metrics）。
const config = require('../project.config');

const STATUS_PENDING = '异常待复查';
const STATUS_RETURNED = '复查退回';
const STATUS_DONE = '已复查';

function now() {
  return new Date().toISOString();
}

function stamp(action, note, actor) {
  return { at: now(), action, note: note || '', actor: actor || '' };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function decimalsOf(value) {
  const text = String(value);
  return text.includes('.') ? text.split('.')[1].length : 0;
}

// 根据样点当前基准，计算某项指标的允许范围
function metricRange(metric, site) {
  const baseline = Number(site?.[metric.baseline]);
  if (!Number.isFinite(baseline)) return null;
  const decimals = Math.max(decimalsOf(baseline), decimalsOf(metric.tolerance));
  return {
    key: metric.name,
    label: metric.label,
    unit: metric.unit,
    baseline,
    tolerance: metric.tolerance,
    min: round(baseline - metric.tolerance, decimals),
    max: round(baseline + metric.tolerance, decimals)
  };
}

function judgeMetric(value, range) {
  const num = Number(value);
  if (!range || !Number.isFinite(num)) {
    return { ...(range || {}), value: value ?? '', ok: false, measured: false };
  }
  return { ...range, value: num, measured: true, ok: num >= range.min && num <= range.max };
}

// 用样点最新基准对一次复查数据做三项判定
function judge(reading, site) {
  const results = config.handling.metrics.map((metric) =>
    judgeMetric(reading?.[metric.name], metricRange(metric, site))
  );
  return {
    at: now(),
    basedOn: {
      baselineTemp: site?.baselineTemp ?? null,
      baselineHumidity: site?.baselineHumidity ?? null,
      baselineCo2: site?.baselineCo2 ?? null
    },
    metrics: results,
    pass: results.length > 0 && results.every((entry) => entry.ok)
  };
}

function summarize(results) {
  return results
    .filter((entry) => !entry.ok)
    .map((entry) =>
      entry.measured
        ? `${entry.label}${entry.value}${entry.unit}超范围（允许 ${entry.min}~${entry.max}${entry.unit}）`
        : `缺少${entry.label}数据`
    )
    .join('；');
}

// 登记处置：指定处置人和复查期限（可对“正常”或“异常待复查”的记录登记）
function register(survey, site, input) {
  const assignee = String(input.assignee || '').trim();
  const dueDate = String(input.dueDate || '').trim();
  const actor = String(input.actor || '').trim();
  const note = String(input.note || '').trim();
  if (!assignee) return { error: '请指定处置人' };
  if (!config.handling.staff.includes(assignee)) return { error: '处置人不在巡测处置名单中' };
  if (!dueDate || Number.isNaN(Date.parse(dueDate))) return { error: '请选择复查期限' };
  if (survey.status === STATUS_DONE) return { error: '已复查的记录无需再次登记' };
  if (survey.assignee && survey.status === STATUS_PENDING) {
    return { error: '该记录已登记处置人，如需换人请使用改派' };
  }

  const time = now();
  Object.assign(survey, {
    status: STATUS_PENDING,
    assignee,
    dueDate,
    registeredAt: survey.registeredAt || time,
    updatedAt: time
  });
  if (note) survey.reviewNote = note;
  survey.history = survey.history || [];
  survey.history.unshift(
    stamp('登记处置', `处置人：${assignee}；复查期限：${dueDate}${note ? `；${note}` : ''}`, actor)
  );
  if (site && site.protectedStatus !== '重点保护' && site.protectedStatus !== '暂停开放') {
    site.protectedStatus = '重点保护';
    site.updatedAt = time;
    site.history = site.history || [];
    site.history.unshift(stamp('关联异常', `巡测 ${survey.date || survey.id} 登记处置，升为重点保护`, actor));
  }
  return { survey, site };
}

// 改派：写明原因，新旧处置人交接留痕
function reassign(survey, input) {
  const to = String(input.to || '').trim();
  const reason = String(input.reason || '').trim();
  const actor = String(input.actor || '').trim();
  if (survey.status === STATUS_DONE) return { error: '已复查的记录不能改派' };
  if (!survey.assignee) return { error: '尚未登记处置人，请先登记' };
  if (!to) return { error: '请选择改派后的处置人' };
  if (!config.handling.staff.includes(to)) return { error: '新处置人不在巡测处置名单中' };
  if (!reason) return { error: '改派必须写明原因' };

  const from = survey.assignee;
  if (to === from) return { error: '新处置人与当前处置人相同' };
  const time = now();
  survey.assignee = to;
  survey.updatedAt = time;
  survey.handover = survey.handover || [];
  survey.handover.unshift({ at: time, from, to, reason, by: actor });
  survey.history = survey.history || [];
  survey.history.unshift(stamp('改派', `${from} → ${to}；原因：${reason}`, actor));
  return { survey };
}

function canSubmit(survey, actor) {
  if (config.handling.dutyLeads.includes(actor)) return true;
  return survey.assignee === actor;
}

// 提交复查：三项数据齐全且全部在样点基准允许范围内才通过；任一项超范围则退回并保留数据
function review(survey, site, input) {
  const actor = String(input.actor || '').trim();
  if (!actor) return { error: '请先在右上角选择当前值班人员' };
  if (survey.status === STATUS_DONE) return { error: '该记录已完成复查' };
  if (!survey.assignee) return { error: '请先登记处置人和复查期限' };
  if (!canSubmit(survey, actor)) {
    return { error: `仅当前处置人（${survey.assignee}）或值班负责人可提交复查` };
  }

  const reading = {
    temperature: input.temperature,
    humidity: input.humidity,
    co2: input.co2
  };
  for (const metric of config.handling.metrics) {
    const num = Number(reading[metric.name]);
    if (reading[metric.name] === '' || reading[metric.name] === undefined || reading[metric.name] === null) {
      return { error: `请填入复查${metric.label}` };
    }
    if (!Number.isFinite(num)) return { error: `复查${metric.label}必须是数字` };
    reading[metric.name] = num;
  }

  const result = judge(reading, site);
  const time = now();
  survey.reviews = survey.reviews || [];
  survey.reviews.unshift({ ...result, at: time, by: actor });
  survey.lastJudge = result;
  survey.updatedAt = time;
  survey.history = survey.history || [];

  if (result.pass) {
    survey.status = STATUS_DONE;
    survey.closedAt = time;
    survey.reviewNote = `复查通过（${actor}）`;
    survey.history.unshift(
      stamp('复查通过', `温度 ${reading.temperature}℃ / 湿度 ${reading.humidity}% / CO2 ${reading.co2}ppm 均在允许范围`, actor)
    );
    return { survey, passed: true };
  }

  survey.status = STATUS_RETURNED;
  survey.reviewNote = `复查退回：${summarize(result.metrics)}`;
  survey.history.unshift(stamp('复查退回', summarize(result.metrics), actor));
  return { survey, passed: false };
}

// 样点基准调整后：所有未完成复查的记录，用新基准对最近一次复查数据重新判定
function rejudgeAfterBaseline(db, site, actor) {
  const affected = [];
  const surveys = db.surveys || [];
  for (const survey of surveys) {
    if (survey.siteId !== site.id) continue;
    if (survey.status === STATUS_DONE) continue;
    const latest = survey.reviews?.[0];
    if (!latest || !latest.metrics) continue;

    const prev = latest.metrics.map((entry) => entry.ok);
    const result = judge(
      { temperature: latest.metrics.find((m) => m.key === 'temperature')?.value,
        humidity: latest.metrics.find((m) => m.key === 'humidity')?.value,
        co2: latest.metrics.find((m) => m.key === 'co2')?.value },
      site
    );
    const next = result.metrics.map((entry) => entry.ok);
    survey.lastJudge = result;
    survey.updatedAt = now();
    survey.history = survey.history || [];

    const flips = config.handling.metrics
      .map((metric, i) => ({ metric, from: prev[i], to: next[i] }))
      .filter((entry) => entry.from !== entry.to);

    if (result.pass && survey.status === STATUS_RETURNED) {
      survey.status = STATUS_PENDING;
      survey.history.unshift(stamp('基准调整重判', '三项指标按新基准均在允许范围，待当前处置人或值班负责人重新提交', actor));
    } else if (!result.pass && flips.length) {
      const parts = flips.map((entry) =>
        entry.to ? `${entry.metric.label}按新基准恢复合格` : `${entry.metric.label}按新基准超出范围`
      );
      survey.status = STATUS_RETURNED;
      survey.reviewNote = `基准调整重判：${summarize(result.metrics)}`;
      survey.history.unshift(stamp('基准调整重判', parts.join('；'), actor));
    }
    affected.push({ id: survey.id, flips: flips.map((entry) => entry.metric.label), pass: result.pass });
  }
  return affected;
}

module.exports = {
  STATUS_PENDING,
  STATUS_RETURNED,
  STATUS_DONE,
  metricRange,
  judge,
  summarize,
  register,
  reassign,
  review,
  rejudgeAfterBaseline,
  canSubmit,
  stamp
};
