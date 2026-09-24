'use strict';

// 存储层：只负责 data/db.json 的读写与一次性迁移，业务规则不放在这里。

const fs = require('fs/promises');
const path = require('path');
const rules = require('./rules');

const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');

async function readDb() {
  const raw = await fs.readFile(DB_FILE, 'utf8');
  return migrate(JSON.parse(raw));
}

async function writeDb(db) {
  await fs.writeFile(DB_FILE, JSON.stringify(db, null, 2) + '\n');
}

// 读时迁移：把早期“异常待复查 + 无处置人”的记录归到“待派单”。
function migrate(db) {
  if (!Array.isArray(db.surveys)) db.surveys = [];
  db.surveys = db.surveys.map(rules.normalizeSurvey);
  if (!Array.isArray(db.sites)) db.sites = [];
  return db;
}

module.exports = { DB_FILE, readDb, writeDb };
