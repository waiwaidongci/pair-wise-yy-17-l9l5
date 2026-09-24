const express = require('express');
const path = require('path');

const config = require('./project.config');
const rules = require('./lib/rules');
const { readDb, writeDb } = require('./lib/store');

const app = express();
const PORT = process.env.PORT || config.port || 3900;

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function stamp(action, note, extra = {}) {
  return { at: new Date().toISOString(), action, note: note || '', ...extra };
}

function sortNewest(a, b) {
  return new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0);
}

// 巡测的流程字段只能通过处置台命令流转，防止普通 PATCH 绕过复查判定。
const SURVEY_GUARDED = ['status', 'assignee', 'reviewDueAt', 'review', 'reviewNote'];

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
  await writeDb(db);
  res.status(201).json(item);
});

app.patch('/api/:collection/:id', async (req, res) => {
  const db = await readDb();
  const { collection, id } = req.params;
  if (!Array.isArray(db[collection])) return res.status(404).json({ error: 'unknown collection' });
  const item = db[collection].find((entry) => entry.id === id);
  if (!item) return res.status(404).json({ error: 'not found' });

  const payload = { ...req.body };
  delete payload.historyAction;
  if (collection === 'surveys') {
    for (const field of SURVEY_GUARDED) delete payload[field];
  }
  Object.assign(item, payload, { updatedAt: new Date().toISOString() });
  item.history = item.history || [];
  if (payload.note || payload.memo) {
    item.history.unshift(stamp('更新', payload.note || payload.memo));
  }
  await writeDb(db);
  res.json(item);
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

// 找到一条巡测记录。
function findSurvey(db, id) {
  const survey = db.surveys?.find((entry) => entry.id === id);
  if (!survey) return { error: '未找到巡测记录', status: 404 };
  return { survey };
}

function finish(res, db, result, status = 200) {
  if (result.error) return res.status(result.status || 409).json({ error: result.error });
  return writeDb(db).then(() => res.status(status).json(result.item));
}

// 标记异常：登记进入“待派单”，同时将样点置为重点保护。
app.post('/api/console/alert/:id', async (req, res) => {
  const db = await readDb();
  const found = findSurvey(db, req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const result = rules.markAlert(db, found.survey, config);
  if (result.error) return res.status(409).json({ error: result.error });
  if (result.site) result.site.protectedStatus = '重点保护';
  await writeDb(db);
  res.json(result.item);
});

// 派单：指定处置人 + 复查期限。
app.post('/api/console/dispatch/:id', async (req, res) => {
  const db = await readDb();
  const found = findSurvey(db, req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const result = rules.dispatch(db, found.survey, req.body || {}, config);
  await finish(res, db, result, 201);
});

// 改派：必须写明原因。
app.post('/api/console/reassign/:id', async (req, res) => {
  const db = await readDb();
  const found = findSurvey(db, req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const result = rules.reassign(db, found.survey, req.body || {}, config);
  await finish(res, db, result);
});

// 提交复查：三项比对当前基准，全过才通过，否则退回留数据。
app.post('/api/console/submit/:id', async (req, res) => {
  const db = await readDb();
  const found = findSurvey(db, req.params.id);
  if (found.error) return res.status(found.status).json({ error: found.error });
  const result = rules.submitReview(db, found.survey, req.body || {}, config);
  await finish(res, db, result);
});

// 调整样点基准：留痕；未完成复查在读取/列表时按新范围动态重判，无需改状态。
app.post('/api/sites/:id/baseline', async (req, res) => {
  const db = await readDb();
  const site = db.sites?.find((entry) => entry.id === req.params.id);
  if (!site) return res.status(404).json({ error: '未找到样点' });
  const body = req.body || {};
  const reason = String(body.reason || '').trim();
  if (!reason) return res.status(400).json({ error: '调整基准必须写明原因' });
  const before = `温度${site.baselineTemp}℃ / 湿度${site.baselineHumidity}% / CO2 ${site.baselineCo2}ppm`;

  const next = {
    baselineTemp: Number(body.baselineTemp),
    baselineHumidity: Number(body.baselineHumidity),
    baselineCo2: Number(body.baselineCo2)
  };
  for (const value of Object.values(next)) {
    if (!Number.isFinite(value)) return res.status(400).json({ error: '基准数值不完整' });
  }
  Object.assign(site, next, { updatedAt: new Date().toISOString() });
  site.history = site.history || [];
  site.history.unshift(
    stamp('基准调整', `${before} → 温度${next.baselineTemp}℃ / 湿度${next.baselineHumidity}% / CO2 ${next.baselineCo2}ppm；原因：${reason}`)
  );
  await writeDb(db);
  res.json(site);
});

// 控制台数据：人员名单 + 处置摘要（含缺项、超基准、逾期判定）。
app.get('/api/console/summary', async (req, res) => {
  const db = await readDb();
  res.json({
    staff: rules.staffList(db, config),
    dutyLeads: config.dutyLeads || [],
    tolerances: config.tolerances,
    summary: rules.consoleSummary(db, config)
  });
});

app.listen(PORT, () => {
  console.log(`${config.title} running at http://localhost:${PORT}`);
});
