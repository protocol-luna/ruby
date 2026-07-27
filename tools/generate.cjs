const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "chain.db");
const ORDER = 4;
const SEP = "\x00";
const MAX_LEN = 30;

const seed = process.argv[2]?.trim();

const db = new Database(DB_PATH);

const stmtStarter = db.prepare(
  "SELECT prefix FROM starters WHERE channel_id = ? ORDER BY RANDOM() LIMIT 1",
);
const stmtStarterSeed = db.prepare(
  "SELECT prefix FROM starters WHERE channel_id = ? AND prefix LIKE ?",
);
const stmtSuffixes = db.prepare(
  "SELECT suffix, count FROM transitions WHERE prefix = ? AND channel_id = ?",
);

function pickPrefix(seed) {
  if (seed) {
    const firstWord = seed.split(/\s+/)[0].toLowerCase();
    const target = seed.toLowerCase().split(/\s+/).join(SEP);
    const rows = stmtStarterSeed.all("", firstWord + "%");
    const matched = rows.filter((r) => r.prefix.toLowerCase().startsWith(target));
    if (matched.length === 0) return null;
    return matched[Math.floor(Math.random() * matched.length)].prefix;
  }
  const row = stmtStarter.get("");
  return row ? row.prefix : null;
}

function generate(seed) {
  const prefix = pickPrefix(seed);
  if (!prefix) {
    console.error("No starter found" + (seed ? ` for seed "${seed}"` : ""));
    process.exit(1);
  }
  const parts = prefix.split(SEP);
  for (let i = 0; i < MAX_LEN; i++) {
    const cur = parts.slice(-ORDER).join(SEP);
    const rows = stmtSuffixes.all(cur, "");
    if (rows.length === 0) break;
    const total = rows.reduce((s, r) => s + r.count, 0);
    let roll = Math.random() * total;
    let next = rows[0].suffix;
    for (const r of rows) {
      roll -= r.count;
      if (roll <= 0) {
        next = r.suffix;
        break;
      }
    }
    parts.push(next);
  }
  return parts.join(" ");
}

console.log(generate(seed));
db.close();
