import { existsSync, readFileSync } from "node:fs";
import { load } from "js-yaml";

export type RubyConfig = {
	port: number;
	host: string;
	order: number;
	max_length: number;
	skip_dm: boolean;
	save_interval_ms: number;
	db_path: string;
};

const DEFAULT_CONFIG: RubyConfig = {
	port: 3127,
	host: "127.0.0.1",
	order: 4,
	max_length: 30,
	skip_dm: true,
	save_interval_ms: 60000,
	db_path: "chain.db",
};

export function loadConfig(path?: string): RubyConfig {
	if (path && existsSync(path)) {
		const yaml = readFileSync(path, "utf-8");
		const parsed = load(yaml) as Partial<RubyConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	}

	const envPath = process.env.RUBY_CONFIG;
	if (envPath && existsSync(envPath)) {
		const yaml = readFileSync(envPath, "utf-8");
		const parsed = load(yaml) as Partial<RubyConfig>;
		return { ...DEFAULT_CONFIG, ...parsed };
	}

	return { ...DEFAULT_CONFIG };
}
