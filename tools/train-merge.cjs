#!/usr/bin/env node
const Database = require("better-sqlite3");
const path = require("path");

const outputPath = process.argv[2];
const tmpPaths = process.argv.slice(3);

console.log(`Merging ${tmpPaths.length} databases into ${outputPath}...`);

const main = new Database(outputPath);
main.pragma("journal_mode = WAL");
main.exec(`
	CREATE TABLE IF NOT EXISTS transitions (
		prefix TEXT NOT NULL, suffix TEXT NOT NULL,
		count INTEGER NOT NULL DEFAULT 1,
		channel_id TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (prefix, suffix, channel_id)
	)
`);
main.exec(`
	CREATE TABLE IF NOT EXISTS starters (
		prefix TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
		PRIMARY KEY (prefix, channel_id)
	)
`);
main.exec("CREATE INDEX IF NOT EXISTS idx_trans_prefix ON transitions(prefix)");

for (const p of tmpPaths) {
	const absPath = path.resolve(p);
	console.log(`  merging ${absPath}...`);
	try {
		main.exec(`ATTACH DATABASE '${absPath.replace(/'/g, "''")}' AS tmp`);
		main.exec(`
			INSERT INTO transitions (prefix, suffix, count, channel_id)
			SELECT prefix, suffix, SUM(count), channel_id
			FROM tmp.transitions
			GROUP BY prefix, suffix, channel_id
			ON CONFLICT(prefix, suffix, channel_id)
			DO UPDATE SET count = count + excluded.count
		`);
		main.exec(`
			INSERT OR IGNORE INTO starters (prefix, channel_id)
			SELECT prefix, channel_id FROM tmp.starters
		`);
		main.exec("DETACH tmp");
	} catch (e) {
		console.error(`  error merging ${p}:`, e.message);
	}
}

const t = main.prepare("SELECT COUNT(*) as c FROM transitions").get();
const s = main.prepare("SELECT COUNT(*) as c FROM starters").get();
console.log(`Result: ${t.c} transitions, ${s.c} starters`);
main.close();
