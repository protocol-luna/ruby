const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "chain.db");
const ORDER = 4;
const SEP = "\x00";

const text = process.argv[2]?.trim();
if (!text) {
  console.error("Usage: node tools/trace.cjs <sentence>");
  process.exit(1);
}

const db = new Database(DB_PATH);
const stmt = db.prepare(
  "SELECT suffix, count FROM transitions WHERE prefix = ? AND channel_id = ? ORDER BY count DESC LIMIT 10",
);
const stmtCount = db.prepare(
  "SELECT COUNT(*) as c FROM transitions WHERE prefix = ? AND channel_id = ?",
);

const words = text.split(/\s+/);
console.log(`Tracing "${text}" (order ${ORDER})\n`);

let totalMatches = 0;
let totalSteps = 0;

for (let i = 0; i <= words.length - ORDER; i++) {
  const prefix = words.slice(i, i + ORDER).join(SEP);
  const chosen = words[i + ORDER];

  const { c: alternatives } = stmtCount.get(prefix, "");
  const rows = stmt.all(prefix, "");

  totalSteps++;
  if (rows.length > 0) totalMatches++;

  if (alternatives === 0) {
    console.log(`  ${i + 1}. "${words.slice(i, i + ORDER).join(" ")}" → ? (no transitions found)`);
    continue;
  }

  const chosenRow = rows.find((r) => r.suffix === chosen);
  const chosenInfo = chosenRow
    ? `chosen="${chosen}" (count=${chosenRow.count})`
    : `chosen="${chosen}" (NOT FOUND)`;

  console.log(
    `  ${i + 1}. "${words.slice(i, i + ORDER).join(" ")}" → ${chosenInfo}  [${alternatives} alternatives total]`,
  );

  if (rows.length > 0) {
    const best = rows.slice(0, 3).map((r) => `${r.suffix}(${r.count})`).join(", ");
    console.log(`       top: ${best}${rows.length > 3 ? "..." : ""}`);
  }
}

console.log(
  `\n${totalSteps} steps, ${totalMatches} matched, ${totalSteps - totalMatches} dead ends`,
);
db.close();
