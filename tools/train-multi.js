#!/usr/bin/env node
import { createReadStream, existsSync, readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const MESSAGES_PATH = join(ROOT, "hf-data", "messages.txt.gz");
const CHECKPOINT_PATH = join(ROOT, "hf-data", "train-checkpoint.txt");
const WORKERS = parseInt(process.env.WORKERS || "4", 10);
const BATCH_SIZE = 10000;

if (isMainThread) {
	main().catch((e) => {
		console.error("Fatal:", e);
		process.exit(1);
	});
} else {
	runWorker();
}

async function main() {
	if (!existsSync(MESSAGES_PATH)) {
		console.error(`Run 'python tools/prepare.py' first to create ${MESSAGES_PATH}`);
		process.exit(1);
	}

	const skip = loadCheckpoint();
	console.log(`Workers: ${WORKERS}, batch: ${BATCH_SIZE}, skip: ${skip.toLocaleString()}`);

	const tmpPaths = [];
	const workers = [];

	for (let i = 0; i < WORKERS; i++) {
		const tmpPath = join(ROOT, "hf-data", `worker-${i}.db`);
		tmpPaths.push(tmpPath);
	}

	// Clean any stale worker DBs
	for (const p of tmpPaths) {
		try { unlinkSync(p); } catch {}
		try { unlinkSync(p + "-wal"); } catch {}
		try { unlinkSync(p + "-shm"); } catch {}
	}

	for (let i = 0; i < WORKERS; i++) {
		workers.push(new Worker(fileURLToPath(import.meta.url), {
			workerData: { workerId: i, tmpPath: tmpPaths[i], batchSize: BATCH_SIZE },
		}));
	}

	let lineNum = 0;
	let msgCount = 0;
	let lastSave = 0;
	const start = Date.now();
	const totalLines = 17002472;

	const rl = createInterface({
		input: createReadStream(MESSAGES_PATH).pipe(createGunzip()),
		crlfDelay: Infinity,
	});

	for await (const raw of rl) {
		lineNum++;
		const line = raw.trim();
		if (!line || lineNum <= skip) continue;

		workers[msgCount % WORKERS].postMessage(line);
		msgCount++;

		if (msgCount - lastSave >= 100000) {
			lastSave = msgCount;
			const elapsed = (Date.now() - start) / 1000;
			const rate = msgCount / elapsed;
			const remaining = totalLines - skip - msgCount;
			console.log(
				`  ${msgCount.toLocaleString()} / ~17M msgs | ${rate.toFixed(0)} msg/s | ETA: ${Math.max(1, (remaining / rate / 60).toFixed(0))} min`,
			);
			saveCheckpoint(lineNum);
		}
	}

	saveCheckpoint(lineNum);

	const elapsed = (Date.now() - start) / 1000;
	console.log(`\nFile done: ${msgCount.toLocaleString()} msgs in ${elapsed.toFixed(0)}s (${(msgCount / elapsed).toFixed(0)} msg/s)`);
	console.log("Signaling workers to finish...");

	for (const w of workers) {
		w.postMessage(null);
	}

	const results = await Promise.all(
		workers.map((w) => new Promise((resolve) => w.on("exit", resolve))),
	);
	console.log("All workers finished. Merging...");

	// Merge: use a forked process to avoid any worker_thread conflicts
	await mergeDatabases(tmpPaths, join(ROOT, "chain.db"));

	console.log("Done!");
	for (const p of tmpPaths) {
		try { unlinkSync(p); } catch {}
		try { unlinkSync(p + "-wal"); } catch {}
		try { unlinkSync(p + "-shm"); } catch {}
	}
}

function loadCheckpoint() {
	if (existsSync(CHECKPOINT_PATH)) {
		return parseInt(readFileSync(CHECKPOINT_PATH, "utf-8").trim(), 10) || 0;
	}
	return 0;
}

function saveCheckpoint(line) {
	const tmp = CHECKPOINT_PATH + ".tmp";
	writeFileSync(tmp, String(line));
	renameSync(tmp, CHECKPOINT_PATH);
}

async function mergeDatabases(tmpPaths, outputPath) {
	// Use child_process fork to avoid worker_thread module conflicts
	const { fork } = await import("node:child_process");
	const child = fork(join(__dirname, "train-merge.cjs"), [outputPath, ...tmpPaths]);
	await new Promise((resolve, reject) => {
		child.on("exit", (code) => {
			if (code === 0) resolve();
			else reject(new Error(`merge exited with code ${code}`));
		});
		child.on("error", reject);
	});
}

function runWorker() {
	const { workerId, tmpPath, batchSize } = workerData;
	const Database = require("better-sqlite3");

	const db = new Database(tmpPath);
	db.pragma("journal_mode = WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS transitions (
			prefix TEXT NOT NULL, suffix TEXT NOT NULL,
			count INTEGER NOT NULL DEFAULT 1,
			channel_id TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (prefix, suffix, channel_id)
		)
	`);
	db.exec(`
		CREATE TABLE IF NOT EXISTS starters (
			prefix TEXT NOT NULL, channel_id TEXT NOT NULL DEFAULT '',
			PRIMARY KEY (prefix, channel_id)
		)
	`);
	db.exec("CREATE INDEX IF NOT EXISTS idx_trans_prefix ON transitions(prefix)");

	const stmtInsertStarter = db.prepare(
		"INSERT OR IGNORE INTO starters (prefix, channel_id) VALUES (?, ?)",
	);
	const stmtUpsertTransition = db.prepare(
		`INSERT INTO transitions (prefix, suffix, count, channel_id)
		 VALUES (?, ?, 1, ?)
		 ON CONFLICT(prefix, suffix, channel_id)
		 DO UPDATE SET count = count + 1`,
	);

	const order = 3;
	const SEP = "\x00";
	let batch = [];

	const tokenize = (text) =>
		text
			.replace(/https?:\/\/\S+/g, "")
			.replace(/<@!?\d+>/g, "")
			.replace(/<a?:\w+:\d+>/g, "")
			.replace(/[^\w\s'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþßœ]/gi, " ")
			.split(/\s+/)
			.filter(Boolean);

	const trainMessage = (text) => {
		const words = tokenize(text);
		if (words.length < order + 1) return;
		const prefix = words.slice(0, order).join(SEP);
		stmtInsertStarter.run(prefix, "");
		for (let i = 0; i < words.length - order; i++) {
			stmtUpsertTransition.run(words.slice(i, i + order).join(SEP), words[i + order], "");
		}
	};

	const flush = () => {
		if (batch.length === 0) return;
		const tx = db.transaction((items) => { for (const t of items) trainMessage(t); });
		tx(batch);
		batch = [];
	};

	parentPort.on("message", (msg) => {
		if (msg === null) {
			flush();
			db.exec("VACUUM");
			db.close();
			parentPort.close();
			return;
		}
		batch.push(msg);
		if (batch.length >= batchSize) flush();
	});
}
