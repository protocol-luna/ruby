const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "chain.db");
const ORDER = 4;
const SEP = "\x00";

const target = process.argv[2]?.trim();
if (!target) {
  console.error("Usage: node tools/reverse.cjs <word>");
  process.exit(1);
}

const db = new Database(DB_PATH);

// Full scan: find all prefixes that produce this word as suffix
const stmt = db.prepare(
  "SELECT prefix, suffix, count FROM transitions WHERE suffix = ? AND channel_id = ? ORDER BY count DESC LIMIT 20",
);

const rows = stmt.all(target, "");

if (rows.length === 0) {
  console.log(`No transitions found with suffix "${target}"`);
  process.exit(0);
}

console.log(`"${target}" appears after these ${ORDER}-word prefixes:\n`);
for (const r of rows) {
  const prefix = r.prefix.replace(/\x00/g, " ");
  console.log(`  "${prefix}" → "${target}"  (count=${r.count})`);
}
console.log(`\n(${rows.length} unique prefixes shown)`);
db.close();
