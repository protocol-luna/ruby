const Database = require('better-sqlite3');
const path = require('path');

const ORDER = 4;
const SEP = '\x00';
const DB = path.join(__dirname, '..', 'chain.db');

const db = new Database(DB, { readonly: true });
db.pragma('journal_mode = WAL');

// In-memory counters for dry-run training
const memTransitions = new Map();

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
  for (let i = 0; i < words.length - ORDER; i++) {
    const prefix = words.slice(i, i + ORDER).join(SEP);
    const suffix = words[i + ORDER];
    const key = prefix + SEP + suffix + SEP + channelId;
    memTransitions.set(key, (memTransitions.get(key) || 0) + 1);
  }
  return true;
}

const allStarters = db.prepare('SELECT prefix FROM starters WHERE channel_id = ?').all('');
const starterList = allStarters.map(r => r.prefix);
console.log(`Loaded ${starterList.length} starters`);

const stmtGetSuffixes = db.prepare('SELECT suffix, count FROM transitions WHERE prefix = ? AND channel_id = ?');

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

// Warmup
for (let i = 0; i < 1000; i++) train(sampleMsgs[i % sampleMsgs.length]);
memTransitions.clear();
for (let i = 0; i < 10; i++) generate();

// Benchmark training (dry — no DB writes)
const TRAIN_N = 500000;
const batch = [];
for (let i = 0; i < TRAIN_N; i++) {
  batch.push(sampleMsgs[i % sampleMsgs.length] + ' ' + i);
}
const t0 = process.hrtime.bigint();
for (const m of batch) train(m);
const t1 = process.hrtime.bigint();
const trainMs = Number(t1 - t0) / 1e6;
console.log(`Training (dry, no DB writes):`);
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

db.close();
