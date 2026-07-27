import { existsSync, readFileSync, writeFileSync } from "node:fs";

export type ChainData = {
	starts: string[];
	entries: Record<string, { count: number; words: Record<string, number> }>;
};

export class MarkovChain {
	private starts: string[] = [];
	private entries = new Map<
		string,
		{ total: number; words: Map<string, number> }
	>();
	private wordCount = 0;
	private order: number;
	private savePath: string;
	private saveTimer: ReturnType<typeof setInterval> | null = null;

	constructor(order = 2, savePath = "chain.json") {
		this.order = order;
		this.savePath = savePath;
		this.load();
	}

	start(saveIntervalMs = 60000) {
		this.saveTimer = setInterval(() => this.save(), saveIntervalMs);
	}

	stop() {
		if (this.saveTimer) clearInterval(this.saveTimer);
		this.save();
	}

	train(text: string) {
		const words = this.tokenize(text);
		if (words.length < this.order + 1) return;

		const prefix = words.slice(0, this.order).join("\x00");
		this.starts.push(prefix);

		for (let i = 0; i < words.length - this.order; i++) {
			const key = words.slice(i, i + this.order).join("\x00");
			const next = words[i + this.order];

			let entry = this.entries.get(key);
			if (!entry) {
				entry = { total: 0, words: new Map() };
				this.entries.set(key, entry);
			}

			entry.total++;
			entry.words.set(next, (entry.words.get(next) ?? 0) + 1);
			this.wordCount++;
		}
	}

	generate(options?: {
		seed?: string;
		maxLength?: number;
	}): string {
		const maxLength = options?.maxLength ?? 30;
		let prefix = this.pickPrefix(options?.seed);
		if (!prefix) return "";

		const parts = prefix.split("\x00");
		const result: string[] = [...parts];

		for (let i = 0; i < maxLength; i++) {
			const entry = this.entries.get(prefix);
			if (!entry || entry.total === 0) break;

			const next = this.sample(entry.words, entry.total);
			if (!next) break;

			result.push(next);
			prefix = result.slice(result.length - this.order).join("\x00");
		}

		return this.detokenize(result);
	}

	getStats() {
		return {
			entries: this.entries.size,
			starts: this.starts.length,
			words: this.wordCount,
			order: this.order,
		};
	}

	private pickPrefix(seed?: string): string | null {
		if (seed) {
			const lower = seed.toLowerCase();
			const candidates = this.starts.filter((s) =>
				s.toLowerCase().startsWith(lower),
			);
			if (candidates.length > 0)
				return candidates[Math.floor(Math.random() * candidates.length)];
		}

		if (this.starts.length === 0) return null;
		return this.starts[Math.floor(Math.random() * this.starts.length)];
	}

	private sample(words: Map<string, number>, total: number): string | null {
		if (total === 0) return null;
		let roll = Math.random() * total;
		for (const [word, count] of words) {
			roll -= count;
			if (roll <= 0) return word;
		}
		return words.keys().next().value ?? null;
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

	private detokenize(words: string[]): string {
		return words.join(" ");
	}

	private save() {
		try {
			const data: ChainData = {
				starts: this.starts,
				entries: {},
			};
			for (const [key, entry] of this.entries) {
				const words: Record<string, number> = {};
				for (const [w, c] of entry.words) words[w] = c;
				data.entries[key] = { count: entry.total, words };
			}
			writeFileSync(this.savePath, JSON.stringify(data), "utf-8");
		} catch (err) {
			console.error("[Ruby] save failed:", err);
		}
	}

	private load() {
		if (!existsSync(this.savePath)) return;
		try {
			const raw = readFileSync(this.savePath, "utf-8");
			const data = JSON.parse(raw) as ChainData;
			this.starts = data.starts ?? [];
			this.wordCount = 0;
			for (const [key, entry] of Object.entries(data.entries ?? {})) {
				const words = new Map(Object.entries(entry.words));
				this.wordCount += entry.count;
				this.entries.set(key, { total: entry.count, words });
			}
			console.log(
				`[Ruby] loaded chain: ${this.entries.size} prefixes, ${this.wordCount} transitions`,
			);
		} catch (err) {
			console.error("[Ruby] load failed:", err);
		}
	}
}
