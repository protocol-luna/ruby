import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import initSqlJs, { type Database as SqlJsDatabase } from "sql.js";

export type GenerateOptions = {
	seed?: string;
	maxLength?: number;
	channelId?: string;
};

export type TrainOptions = {
	text: string;
	isDM?: boolean;
	channelId?: string;
	userId?: string;
	platform?: string;
};

export class MarkovChain {
	private db: SqlJsDatabase | null = null;
	private savePath = "chain.db";
	private trainedSinceSave = 0;
	private stmtInsertStarter: any = null;
	private stmtUpsertTransition: any = null;

	async init(savePath?: string) {
		this.savePath = savePath ?? "chain.db";
		const SQL = await initSqlJs();

		if (existsSync(this.savePath + ".tmp")) {
			renameSync(this.savePath + ".tmp", this.savePath);
		}

		if (existsSync(this.savePath)) {
			const buffer = readFileSync(this.savePath);
			this.db = new SQL.Database(buffer);
		} else {
			this.db = new SQL.Database();
		}

		this.db.run(`
			CREATE TABLE IF NOT EXISTS transitions (
				prefix TEXT NOT NULL,
				suffix TEXT NOT NULL,
				count INTEGER NOT NULL DEFAULT 1,
				channel_id TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (prefix, suffix, channel_id)
			)
		`);
		this.db.run(`
			CREATE TABLE IF NOT EXISTS starters (
				prefix TEXT NOT NULL,
				channel_id TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (prefix, channel_id)
			)
		`);
		this.db.run(`
			CREATE INDEX IF NOT EXISTS idx_trans_prefix ON transitions(prefix)
		`);

		this.stmtInsertStarter = this.db.prepare(
			"INSERT OR IGNORE INTO starters (prefix, channel_id) VALUES (?, ?)",
		);
		this.stmtUpsertTransition = this.db.prepare(
			`INSERT INTO transitions (prefix, suffix, count, channel_id)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(prefix, suffix, channel_id)
			 DO UPDATE SET count = count + 1`,
		);

		const stats = this.getStats();
		console.log(
			`[Ruby] loaded chain: ${stats.transitions} transitions, ${stats.starts} starters`,
		);
	}

	start() {}

	stop() {
		this.save();
	}

	train(opts: TrainOptions) {
		if (opts.isDM) return;
		const words = this.tokenize(opts.text);
		if (words.length < 3) return;
		this.insertWords(words, opts.channelId ?? "");
	}

	trainMany(optsList: TrainOptions[]) {
		this.db!.exec("BEGIN");
		try {
			for (const opts of optsList) {
				if (opts.isDM) continue;
				const words = this.tokenize(opts.text);
				if (words.length < 3) continue;
				this.insertWords(words, opts.channelId ?? "");
			}
			this.db!.exec("COMMIT");
		} catch (err) {
			this.db!.exec("ROLLBACK");
			throw err;
		}
	}

	maybeSave() {
		if (this.trainedSinceSave > 500000) {
			this.save();
			this.trainedSinceSave = 0;
		}
	}

	private insertWords(words: string[], channelId: string) {
		const prefix = words.slice(0, 2).join("\x00");

		this.stmtInsertStarter.bind([prefix, channelId]);
		this.stmtInsertStarter.step();
		this.stmtInsertStarter.reset();

		for (let i = 0; i < words.length - 2; i++) {
			const key = words.slice(i, i + 2).join("\x00");
			const next = words[i + 2];
			this.stmtUpsertTransition.bind([key, next, channelId]);
			this.stmtUpsertTransition.step();
			this.stmtUpsertTransition.reset();
		}
		this.trainedSinceSave += words.length - 2;
	}

	generate(opts?: GenerateOptions): string {
		const maxLength = opts?.maxLength ?? 30;
		const channelId = opts?.channelId ?? "";

		const prefix = this.pickPrefix(opts?.seed, channelId);
		if (!prefix) return "";

		const parts = prefix.split("\x00");
		const result: string[] = [...parts];

		for (let i = 0; i < maxLength; i++) {
			const next = this.sampleNext(parts.slice(-2).join("\x00"), channelId);
			if (!next) break;
			result.push(next);
			parts.push(next);
			if (parts.length > 2) parts.shift();
		}

		return result.join(" ");
	}

	getStats() {
		const tRow = this.db!.exec("SELECT COUNT(*) as c FROM transitions");
		const sRow = this.db!.exec("SELECT COUNT(*) as c FROM starters");
		return {
			transitions: (tRow[0]?.values[0]?.[0] as number) ?? 0,
			starts: (sRow[0]?.values[0]?.[0] as number) ?? 0,
		};
	}

	getChannels(): string[] {
		const rows = this.db!.exec(
			"SELECT DISTINCT channel_id FROM transitions WHERE channel_id != '' ORDER BY channel_id",
		);
		return (rows[0]?.values.map((r) => r[0] as string) ?? []).filter(Boolean);
	}

	private pickPrefix(seed?: string, channelId?: string): string | null {
		let rows: unknown[][];
		if (seed) {
			const pattern = seed.toLowerCase() + "%";
			if (channelId) {
				rows =
					this.db!.exec("SELECT prefix FROM starters WHERE prefix LIKE ? AND channel_id = ?", [
						pattern,
						channelId,
					])[0]?.values ?? [];
			} else {
				rows =
					this.db!.exec("SELECT prefix FROM starters WHERE prefix LIKE ?", [pattern])[0]
						?.values ?? [];
			}
		} else {
			if (channelId) {
				rows =
					this.db!.exec("SELECT prefix FROM starters WHERE channel_id = ?", [channelId])[0]
						?.values ?? [];
			} else {
				rows =
					this.db!.exec("SELECT prefix FROM starters")[0]?.values ?? [];
			}
		}
		if (rows.length === 0) return null;
		return rows[Math.floor(Math.random() * rows.length)][0] as string;
	}

	private sampleNext(prefix: string, channelId?: string): string | null {
		let rows: unknown[][];
		if (channelId) {
			rows =
				this.db!.exec(
					"SELECT suffix, count FROM transitions WHERE prefix = ? AND channel_id = ?",
					[prefix, channelId],
				)[0]?.values ?? [];
		} else {
			rows =
				this.db!.exec(
					"SELECT suffix, SUM(count) as total FROM transitions WHERE prefix = ? GROUP BY suffix",
					[prefix],
				)[0]?.values ?? [];
		}

		if (rows.length === 0) return null;

		const total = rows.reduce((sum, r) => sum + (r[1] as number), 0);
		let roll = Math.random() * total;
		for (const [suffix, count] of rows) {
			roll -= count as number;
			if (roll <= 0) return suffix as string;
		}
		return rows[rows.length - 1][0] as string;
	}

	private tokenize(text: string): string[] {
		return text
			.replace(/https?:\/\/\S+/g, "")
			.replace(/<@!?\d+>/g, "")
			.replace(/<a?:\w+:\d+>/g, "")
			.replace(/[^\w\s'àáâãäåæçèéêëìíîïðñòóôõöøùúûüýþßœ]/gi, " ")
			.split(/\s+/)
			.filter(Boolean);
	}

	save() {
		if (!this.db) return;
		try {
			this.db.exec("VACUUM");
			const data = this.db.export();
			const tmpPath = this.savePath + ".tmp";
			writeFileSync(tmpPath, Buffer.from(data));
			renameSync(tmpPath, this.savePath);
			this.stmtInsertStarter?.free();
			this.stmtUpsertTransition?.free();
			this.stmtInsertStarter = this.db.prepare(
				"INSERT OR IGNORE INTO starters (prefix, channel_id) VALUES (?, ?)",
			);
			this.stmtUpsertTransition = this.db.prepare(
				`INSERT INTO transitions (prefix, suffix, count, channel_id)
				 VALUES (?, ?, 1, ?)
				 ON CONFLICT(prefix, suffix, channel_id)
				 DO UPDATE SET count = count + 1`,
			);
		} catch (err) {
			console.error("[Ruby] save failed:", err);
		}
	}
}
