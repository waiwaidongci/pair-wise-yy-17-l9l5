'use strict';

// 规则单测：node test/rules.test.js（无第三方依赖）。
const assert = require('assert');
const rules = require('../lib/rules');

const config = {
  tolerances: { temp: 1, humidity: 5, co2: 150 },
  dutyLeads: ['值班负责人']
};

function setup() {
  return {
    sites: [
      {
        id: 's1',
        cave: '北麓三号洞',
        zone: '滴水帘区',
        pointCode: 'D-07',
        protectedStatus: '常规观察',
        baselineTemp: 16.2,
        baselineHumidity: 92,
        baselineCo2: 680,
        history: []
      }
    ],
    surveys: [
      {
        id: 'v1',
        siteId: 's1',
        surveyor: '沈宁',
        date: '2026-06-18',
        temperature: 17.4,
        humidity: 88,
        co2: 920,
        status: '正常',
        history: []
      }
    ]
  };
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`✓ ${name}`);
}

// 标记异常 -> 待派单
test('标记异常进入待派单且清空派单字段', () => {
  const db = setup();
  const r = rules.markAlert(db, db.surveys[0], config);
  assert.equal(r.error, undefined);
  assert.equal(db.surveys[0].status, '待派单');
  assert.equal(db.surveys[0].assignee, '');
});

// 待派单 -> 派单
test('派单需要处置人和期限', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  assert.equal(rules.dispatch(db, v, { assignee: '', reviewDueAt: '2026-09-30' }, config).error, '请指定处置人');
  assert.equal(rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '' }, config).error, '请填写复查期限');
  const r = rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  assert.equal(r.error, undefined);
  assert.equal(v.status, '处理中');
  assert.equal(v.assignee, '甲');
});

// 改派必须写原因
test('改派必须写明原因且不能与原处置人相同', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  assert.equal(rules.reassign(db, v, { assignee: '乙', reason: '' }, config).error, '改派必须写明原因');
  assert.equal(rules.reassign(db, v, { assignee: '甲', reason: '换人' }, config).error, '新处置人与当前处置人相同');
  const r = rules.reassign(db, v, { assignee: '乙', reason: '甲请假' }, config);
  assert.equal(r.error, undefined);
  assert.equal(v.assignee, '乙');
  assert.match(v.history[0].note, /原处置人：甲 → 新处置人：乙；原因：甲请假/);
});

// 提交权限：仅当前处置人或值班负责人
test('非当前处置人且非值班负责人不能提交', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  const r = rules.submitReview(db, v, { submitter: '路人', temperature: 16.5, humidity: 92, co2: 700 }, config);
  assert.equal(r.error, '只有当前处置人或值班负责人可以提交复查');
});

// 三项缺一项不能提交
test('缺少任一项数据不能提交', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  const r = rules.submitReview(db, v, { submitter: '甲', temperature: 16.5, humidity: '', co2: 700 }, config);
  assert.equal(r.error, '缺少复查数据：湿度');
});

// 三项都在范围内 -> 通过（范围 15.2~17.2, 87~97, 530~830）
test('三项都在基准允许范围内才通过', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  const r = rules.submitReview(db, v, { submitter: '甲', temperature: 16.5, humidity: 90, co2: 700 }, config);
  assert.equal(r.error, undefined);
  assert.equal(v.status, '已复查');
  assert.equal(v.review.passed, true);
});

// 任一项超出 -> 退回并保留数据
test('CO2超出范围则退回且数据留存', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  const r = rules.submitReview(db, v, { submitter: '值班负责人', temperature: 16.5, humidity: 90, co2: 900 }, config);
  assert.equal(r.error, undefined);
  assert.equal(v.status, '复查退回');
  assert.equal(v.review.passed, false);
  assert.equal(v.review.readings.co2, 900); // 数据保留
  assert.deepEqual(v.review.checks.find((c) => c.key === 'co2').value, 900);
});

// 值班负责人可以提交
test('值班负责人可代为提交', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  const r = rules.submitReview(db, v, { submitter: '值班负责人', temperature: 16.5, humidity: 90, co2: 700 }, config);
  assert.equal(r.error, undefined);
  assert.equal(v.status, '已复查');
});

// 退回后可再次提交（整改后重新复查）
test('退回后改派并重新复查通过', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  rules.submitReview(db, v, { submitter: '甲', temperature: 16.5, humidity: 90, co2: 900 }, config);
  assert.equal(v.status, '复查退回');
  const r = rules.submitReview(db, v, { submitter: '甲', temperature: 16.5, humidity: 90, co2: 700 }, config);
  assert.equal(r.error, undefined);
  assert.equal(v.status, '已复查');
});

// 基准调整后未完成复查按新范围重判（判定始终读当前基准）
test('基准调整后未完成复查按新范围重判', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  // CO2 基准 680±150 -> 900 超限，先退回
  rules.submitReview(db, v, { submitter: '甲', temperature: 16.5, humidity: 90, co2: 900 }, config);
  assert.equal(v.status, '复查退回');
  // 基准放宽：CO2 基准调到 850，范围 700~1000，900 现在在范围内
  Object.assign(db.sites[0], { baselineCo2: 850 });
  const summary = rules.consoleSummary(db, config);
  const row = summary.rows.find((row) => row.survey.id === 'v1');
  const co2Check = row.latestChecks.find((c) => c.key === 'co2');
  assert.equal(co2Check.inRange, true);
  assert.equal(row.exceeded.length, 0);
  // 重新提交即通过
  const r = rules.submitReview(db, v, { submitter: '甲', temperature: 16.5, humidity: 90, co2: 900 }, config);
  assert.equal(v.status, '已复查');
});

// 列表看得出谁在处理、缺哪项
test('控制台行展示处置人与缺项', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  let row = rules.consoleSummary(db, config).rows[0];
  assert.equal(row.assignee, '');
  assert.ok(row.missing.includes('处置人'));
  assert.ok(row.missing.includes('复查期限'));
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-30' }, config);
  row = rules.consoleSummary(db, config).rows[0];
  assert.equal(row.assignee, '甲');
  // 处理中且还没复查数据时，缺三项
  assert.ok(row.missing.includes('复查温度'));
});

// 逾期判定
test('超过复查期限标记逾期', () => {
  const db = setup();
  const v = db.surveys[0];
  rules.markAlert(db, v, config);
  rules.dispatch(db, v, { assignee: '甲', reviewDueAt: '2026-09-01' }, config);
  assert.equal(rules.isOverdue(v, new Date('2026-09-23T12:00:00')), true);
  assert.equal(rules.isOverdue(v, new Date('2026-09-01T10:00:00')), false);
});

// 遗留数据迁移
test('遗留“异常待复查”记录迁移为待派单', () => {
  const migrated = rules.normalizeSurvey({ status: '异常待复查' });
  assert.equal(migrated.status, '待派单');
  const withAssignee = rules.normalizeSurvey({ status: '异常待复查', assignee: '甲' });
  assert.equal(withAssignee.status, '处理中');
});

console.log(`\n${passed} 项规则测试全部通过`);
