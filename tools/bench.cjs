const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const ORDER = 4;
const SEP = '\x00';
const TMP_DB = path.join(__dirname, '..', 'bench-tmp.db');
const SRC_DB = path.join(__dirname, '..', 'chain.db');

// Copy chain.db to temp to avoid corrupting the real one
fs.copyFileSync(SRC_DB, TMP_DB);
const db = new Database(TMP_DB);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = OFF');

function tokenize(text) {
  return text
    .replace(/https?:\/\/\S+/g, '')
    .replace(/<@!?\d+>/g, '')
    .replace(/<a?:\w+:\d+>/g, '')
    .replace(/[^a-zA-Z0-9_\s']/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 0);
}

function train(text, channelId = '') {
  const words = tokenize(text);
  if (words.length < ORDER + 1) return false;
  stmtInsertStarter.run(words.slice(0, ORDER).join(SEP), channelId);
  for (let i = 0; i < words.length - ORDER; i++) {
    stmtUpsertTransition.run(words.slice(i, i + ORDER).join(SEP), words[i + ORDER], channelId);
  }
  return true;
}

// Preload all starters into a JS array (avoids ORDER BY RANDOM() on 1.1M rows)
const allStarters = db.prepare('SELECT prefix FROM starters WHERE channel_id = ?').all('');
const starterList = allStarters.map(r => r.prefix);
console.log(`Loaded ${starterList.length} starters`);

const stmtGetSuffixes = db.prepare('SELECT suffix, count FROM transitions WHERE prefix = ? AND channel_id = ?');
const stmtInsertStarter = db.prepare('INSERT OR IGNORE INTO starters (prefix, channel_id) VALUES (?, ?)');
const stmtUpsertTransition = db.prepare('INSERT INTO transitions (prefix, suffix, count, channel_id) VALUES (?, ?, 1, ?) ON CONFLICT(prefix, suffix, channel_id) DO UPDATE SET count = count + 1');

function generate(maxLen = 30) {
  if (starterList.length === 0) return null;
  const prefix = starterList[Math.floor(Math.random() * starterList.length)];
  const parts = prefix.split(SEP);
  for (let i = 0; i < maxLen; i++) {
    const cur = parts.slice(-ORDER).join(SEP);
    const rows = stmtGetSuffixes.all(cur, '');
    if (rows.length === 0) break;
    const total = rows.reduce((s, r) => s + r.count, 0);
    let roll = Math.random() * total;
    let next = rows[0].suffix;
    for (const r of rows) {
      roll -= r.count;
      if (roll <= 0) { next = r.suffix; break; }
    }
    parts.push(next);
  }
  return parts.join(' ');
}

const sampleMsgs = [
  'hello everyone how are you doing today',
  'i think we should go to the park later',
  'this is a test message for benchmarking',
  'what do you think about the new update',
  'i like playing games with my friends',
  'can someone help me with this problem',
  'that movie was really good i enjoyed it',
  'the weather is nice today lets go outside',
  'i need to finish my homework before tomorrow',
  'have you seen the latest episode yet',
];

const TRANSACTIONS = db.transaction((msgs) => {
  for (const m of msgs) train(m);
});

// Warmup
for (let i = 0; i < 100; i++) TRANSACTIONS(sampleMsgs);
for (let i = 0; i < 10; i++) generate();

// Benchmark training
const TRAIN_N = 200000;
const batch = [];
for (let i = 0; i < TRAIN_N; i++) {
  batch.push(sampleMsgs[i % sampleMsgs.length] + ' ' + i);
}
const t0 = process.hrtime.bigint();
TRANSACTIONS(batch);
const t1 = process.hrtime.bigint();
const trainMs = Number(t1 - t0) / 1e6;
console.log(`Training:`);
console.log(`  ${Math.round(TRAIN_N / (trainMs / 1000))} msgs/s`);
console.log(`  ${TRAIN_N} msgs in ${Math.round(trainMs)} ms`);

// Benchmark generation
const GEN_N = 100000;
const t2 = process.hrtime.bigint();
let totalWords = 0;
let count = 0;
for (let i = 0; i < GEN_N; i++) {
  const out = generate();
  if (out) {
    totalWords += out.split(' ').length;
    count++;
  }
}
const t3 = process.hrtime.bigint();
const genMs = Number(t3 - t2) / 1e6;
console.log(`Generation:`);
console.log(`  ${Math.round(GEN_N / (genMs / 1000))} gen/s`);
console.log(`  ${GEN_N} gens in ${Math.round(genMs)} ms`);
console.log(`  avg ${Math.round((totalWords / count) * 10) / 10} words (${count} successful)`);

const fileSize = fs.statSync(TMP_DB).size;
console.log(`DB size: ${(fileSize / 1024 / 1024).toFixed(0)} MB`);

db.close();
fs.unlinkSync(TMP_DB);
