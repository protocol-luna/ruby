/**
 * Backfill Ruby with Discord message history.
 *
 * Reads Jade's config for the bot token, iterates all accessible text channels,
 * fetches message history, and POSTs to Ruby's /train endpoint.
 *
 * Usage:
 *   DISCORD_TOKEN=... npx tsx tools/backfill.ts
 *   # or with Jade config:
 *   npx tsx tools/backfill.ts --jade-config ../jade/config.yml
 *
 * Resumable: checkpoints last message ID per channel in backfill-checkpoint.json
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";

const RUBY_URL = process.env.RUBY_URL ?? "http://127.0.0.1:3127";
const CHECKPOINT_PATH = "backfill-checkpoint.json";

type Checkpoint = Record<string, string | null>;

function loadCheckpoint(): Checkpoint {
	try {
		if (existsSync(CHECKPOINT_PATH))
			return JSON.parse(readFileSync(CHECKPOINT_PATH, "utf-8"));
	} catch { /* ignore */ }
	return {};
}

function saveCheckpoint(cp: Checkpoint) {
	writeFileSync(CHECKPOINT_PATH, JSON.stringify(cp, null, 2));
}

let _rateLimitRemaining = 50;
let _rateLimitReset = 0;

async function discordFetch(
	token: string,
	path: string,
): Promise<{ data: unknown; headers: Headers }> {
	while (_rateLimitRemaining === 0 && Date.now() < _rateLimitReset * 1000) {
		const wait = _rateLimitReset * 1000 - Date.now() + 100;
		console.log(`[rate] waiting ${wait}ms for reset`);
		await new Promise((r) => setTimeout(r, Math.min(wait, 5000)));
	}

	const resp = await fetch(`https://discord.com/api/v10${path}`, {
		headers: { Authorization: `Bot ${token}` },
	});

	_rateLimitRemaining = Number(resp.headers.get("X-RateLimit-Remaining") ?? "1");
	_rateLimitReset = Number(resp.headers.get("X-RateLimit-Reset") ?? "0");

	if (resp.status === 429) {
		const retryAfter = Number(resp.headers.get("Retry-After") ?? "5");
		console.log(`[rate] 429, retrying after ${retryAfter}s`);
		await new Promise((r) => setTimeout(r, retryAfter * 1000 + 100));
		return discordFetch(token, path);
	}

	if (!resp.ok) {
		const body = await resp.text().catch(() => "");
		throw new Error(`discord ${resp.status} ${path}: ${body.slice(0, 200)}`);
	}

	const data = await resp.json();
	return { data, headers: resp.headers };
}

async function getGuilds(token: string): Promise<{ id: string; name: string }[]> {
	const { data } = await discordFetch(token, "/users/@me/guilds");
	return data as { id: string; name: string }[];
}

async function getChannels(
	token: string,
	guildId: string,
): Promise<{ id: string; name: string; type: number }[]> {
	const { data } = await discordFetch(token, `/guilds/${guildId}/channels`);
	return data as { id: string; name: string; type: number }[];
}

async function fetchMessages(
	token: string,
	channelId: string,
	before?: string,
): Promise<{ id: string; content: string; author: { id: string; username: string }; timestamp: string }[]> {
	let path = `/channels/${channelId}/messages?limit=100`;
	if (before) path += `&before=${before}`;
	const { data } = await discordFetch(token, path);
	return data as any[];
}

async function trainRuby(
	text: string,
	channelId: string,
	userId: string,
) {
	try {
		const resp = await fetch(`${RUBY_URL}/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				text,
				channel_id: channelId,
				user_id: userId,
				platform: "discord",
				isDM: false,
			}),
		});
		if (!resp.ok) {
			const err = await resp.text().catch(() => "");
			console.error(`[ruby] train error ${resp.status}: ${err.slice(0, 100)}`);
		}
	} catch (err) {
		console.error("[ruby] train failed:", (err as Error).message);
	}
}

async function backfillChannel(
	token: string,
	channelId: string,
	channelName: string,
	checkpoint: Checkpoint,
) {
	const key = channelId;
	let before = checkpoint[key] ?? undefined;
	let total = 0;
	let batch = 0;
	let emptyRuns = 0;

	while (emptyRuns < 3) {
		const messages = await fetchMessages(token, channelId, before);
		if (messages.length === 0) {
			emptyRuns++;
			if (emptyRuns >= 3) break;
			await new Promise((r) => setTimeout(r, 1000));
			continue;
		}
		emptyRuns = 0;

		for (const msg of messages) {
			if (!msg.content || msg.content.startsWith("-")) continue;
			await trainRuby(msg.content, channelId, msg.author.id);
			total++;
			before = msg.id;
			checkpoint[key] = msg.id;
		}

		batch++;
		if (batch % 10 === 0) {
			saveCheckpoint(checkpoint);
			console.log(`  [${channelName}] ${total} messages...`);
		}

		await new Promise((r) => setTimeout(r, 50));
	}

	console.log(`  [${channelName}] done: ${total} messages`);
}

async function main() {
	let jadeConfigPath: string | null = null;
	for (let i = 2; i < process.argv.length; i++) {
		if (process.argv[i] === "--jade-config" && i + 1 < process.argv.length)
			jadeConfigPath = process.argv[i + 1];
	}

	let token = process.env.DISCORD_TOKEN;
	if (!token && jadeConfigPath && existsSync(jadeConfigPath)) {
		const cfg = load(readFileSync(jadeConfigPath, "utf-8")) as Record<string, unknown>;
		token = (cfg.discord_token as string) ?? null!;
	}
	if (!token) {
		console.error(
			"Usage: DISCORD_TOKEN=... npx tsx tools/backfill.ts\n" +
			"   or: npx tsx tools/backfill.ts --jade-config ../jade/config.yml",
		);
		process.exit(1);
	}

	console.log("Fetching guilds...");
	const guilds = await getGuilds(token);
	console.log(`Found ${guilds.length} guilds\n`);

	const checkpoint = loadCheckpoint();

	for (const guild of guilds) {
		console.log(`\n== ${guild.name} (${guild.id}) ==`);
		const channels = await getChannels(token, guild.id);
		const textChannels = channels.filter(
			(c) => c.type === 0, // GUILD_TEXT
		);
		console.log(`  ${textChannels.length} text channels`);

		for (const ch of textChannels) {
			process.stdout.write(`  ${ch.name}: `);
			await backfillChannel(token, ch.id, `${guild.name}#${ch.name}`, checkpoint);
			saveCheckpoint(checkpoint);
		}
	}

	console.log("\nDone! Checkpoint saved.");
}

main().catch((err) => {
	console.error("Fatal:", err);
	process.exit(1);
});
