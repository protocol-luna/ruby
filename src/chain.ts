import { existsSync, renameSync } from "node:fs";
import Database from "better-sqlite3";

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
	private db: Database.Database | null = null;
	private savePath = "chain.db";
	private order = 2;
	private trainedSinceSave = 0;
	private stmtInsertStarter: Database.Statement<[string, string]> | null = null;
	private stmtUpsertTransition: Database.Statement<[string, string, string]> | null = null;
	private stmtPickAll: Database.Statement<[], { prefix: string }> | null = null;
	private stmtPickChannel: Database.Statement<[string], { prefix: string }> | null = null;
	private stmtPickSeed: Database.Statement<[string], { prefix: string }> | null = null;
	private stmtPickSeedChannel: Database.Statement<[string, string], { prefix: string }> | null = null;
	private stmtSampleAll: Database.Statement<[string], { suffix: string; count: number }> | null = null;
	private stmtSampleChannel: Database.Statement<[string, string], { suffix: string; count: number }> | null = null;

	init(savePath?: string, order?: number) {
		this.order = order ?? 2;
		this.savePath = savePath ?? "chain.db";

		if (existsSync(this.savePath + ".tmp")) {
			renameSync(this.savePath + ".tmp", this.savePath);
		}

		this.db = new Database(this.savePath);
		this.db.pragma("journal_mode = WAL");

		this.db.exec(`
			CREATE TABLE IF NOT EXISTS transitions (
				prefix TEXT NOT NULL,
				suffix TEXT NOT NULL,
				count INTEGER NOT NULL DEFAULT 1,
				channel_id TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (prefix, suffix, channel_id)
			)
		`);
		this.db.exec(`
			CREATE TABLE IF NOT EXISTS starters (
				prefix TEXT NOT NULL,
				channel_id TEXT NOT NULL DEFAULT '',
				PRIMARY KEY (prefix, channel_id)
			)
		`);
		this.db.exec(`
			CREATE INDEX IF NOT EXISTS idx_trans_prefix ON transitions(prefix)
		`);

		this.stmtInsertStarter = this.db.prepare(
			"INSERT OR IGNORE INTO starters (prefix, channel_id) VALUES (?, ?)",
		) as Database.Statement<[string, string]>;
		this.stmtUpsertTransition = this.db.prepare(
			`INSERT INTO transitions (prefix, suffix, count, channel_id)
			 VALUES (?, ?, 1, ?)
			 ON CONFLICT(prefix, suffix, channel_id)
			 DO UPDATE SET count = count + 1`,
		) as Database.Statement<[string, string, string]>;

		this.stmtPickAll = this.db.prepare(
			"SELECT prefix FROM starters",
		) as Database.Statement<[], { prefix: string }>;
		this.stmtPickChannel = this.db.prepare(
			"SELECT prefix FROM starters WHERE channel_id = ?",
		) as Database.Statement<[string], { prefix: string }>;
		this.stmtPickSeed = this.db.prepare(
			"SELECT prefix FROM starters WHERE prefix LIKE ?",
		) as Database.Statement<[string], { prefix: string }>;
		this.stmtPickSeedChannel = this.db.prepare(
			"SELECT prefix FROM starters WHERE prefix LIKE ? AND channel_id = ?",
		) as Database.Statement<[string, string], { prefix: string }>;

		this.stmtSampleAll = this.db.prepare(
			"SELECT suffix, SUM(count) as count FROM transitions WHERE prefix = ? GROUP BY suffix",
		) as Database.Statement<[string], { suffix: string; count: number }>;
		this.stmtSampleChannel = this.db.prepare(
			"SELECT suffix, count FROM transitions WHERE prefix = ? AND channel_id = ?",
		) as Database.Statement<[string, string], { suffix: string; count: number }>;

		const stats = this.getStats();
		console.log(
			`[Ruby] loaded chain: ${stats.transitions} transitions, ${stats.starts} starters (order ${this.order})`,
		);
	}

	close() {
		this.db?.close();
	}

	train(opts: TrainOptions) {
		if (opts.isDM) return;
		const words = this.tokenize(opts.text);
		if (words.length < this.order + 1) return;
		this.insertWords(words, opts.channelId ?? "");
	}

	trainMany(optsList: TrainOptions[]) {
		const insertBatch = this.db!.transaction((items: TrainOptions[]) => {
			for (const opts of items) {
				if (opts.isDM) continue;
				const words = this.tokenize(opts.text);
				if (words.length < this.order + 1) continue;
				this.insertWords(words, opts.channelId ?? "");
			}
		});
		insertBatch(optsList);
	}

	maybeVacuum() {
		if (this.trainedSinceSave > 500000) {
			this.db!.exec("VACUUM");
			this.trainedSinceSave = 0;
		}
	}

	private insertWords(words: string[], channelId: string) {
		const prefix = words.slice(0, this.order).join("\x00");

		this.stmtInsertStarter!.run(prefix, channelId);

		for (let i = 0; i < words.length - this.order; i++) {
			const key = words.slice(i, i + this.order).join("\x00");
			const next = words[i + this.order];
			this.stmtUpsertTransition!.run(key, next, channelId);
		}
		this.trainedSinceSave += words.length - this.order;
	}

	generate(opts?: GenerateOptions): string {
		const maxLength = opts?.maxLength ?? 30;
		const channelId = opts?.channelId ?? "";

		const prefix = this.pickPrefix(opts?.seed, channelId);
		if (!prefix) return "";

		const parts = prefix.split("\x00");
		const result: string[] = [...parts];

		for (let i = 0; i < maxLength; i++) {
			const next = this.sampleNext(parts.slice(-this.order).join("\x00"), channelId);
			if (!next) break;
			result.push(next);
			parts.push(next);
			if (parts.length > this.order) parts.shift();
		}

		return result.join(" ");
	}

	getStats() {
		const tRow = this.db!.prepare("SELECT COUNT(*) as c FROM transitions").get() as { c: number };
		const sRow = this.db!.prepare("SELECT COUNT(*) as c FROM starters").get() as { c: number };
		return {
			transitions: tRow?.c ?? 0,
			starts: sRow?.c ?? 0,
		};
	}

	getChannels(): string[] {
		const rows = this.db!.prepare(
			"SELECT DISTINCT channel_id FROM transitions WHERE channel_id != '' ORDER BY channel_id",
		).all() as { channel_id: string }[];
		return rows.map((r) => r.channel_id).filter(Boolean);
	}

	private pickPrefix(seed?: string, channelId?: string): string | null {
		let rows: { prefix: string }[];
		if (seed) {
			const pattern = seed.toLowerCase() + "%";
			if (channelId) {
				rows = this.stmtPickSeedChannel!.all(pattern, channelId);
			} else {
				rows = this.stmtPickSeed!.all(pattern);
			}
		} else {
			if (channelId) {
				rows = this.stmtPickChannel!.all(channelId);
			} else {
				rows = this.stmtPickAll!.all();
			}
		}
		if (rows.length === 0) return null;
		return rows[Math.floor(Math.random() * rows.length)].prefix;
	}

	private sampleNext(prefix: string, channelId?: string): string | null {
		let rows: { suffix: string; count: number }[];
		if (channelId) {
			rows = this.stmtSampleChannel!.all(prefix, channelId);
		} else {
			rows = this.stmtSampleAll!.all(prefix);
		}
		if (rows.length === 0) return null;

		const total = rows.reduce((sum, r) => sum + r.count, 0);
		let roll = Math.random() * total;
		for (const row of rows) {
			roll -= row.count;
			if (roll <= 0) return row.suffix;
		}
		return rows[rows.length - 1].suffix;
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
}
