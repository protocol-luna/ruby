import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "./config";
import { RubyServer } from "./server";

const configPath = existsSync(join(process.cwd(), "config.yml"))
	? join(process.cwd(), "config.yml")
	: undefined;
const config = loadConfig(configPath);

const server = new RubyServer(config);
server.start().catch((err) => {
	console.error("[Ruby] failed to start:", err);
	process.exit(1);
});

process.on("SIGINT", () => {
	console.log("[Ruby] shutting down...");
	server.stop();
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("[Ruby] shutting down...");
	server.stop();
	process.exit(0);
});
