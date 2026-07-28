import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { RubyServer } from "../src/server";
import type { RubyConfig } from "../src/config";

let server: RubyServer;
let baseUrl: string;

async function waitForServer(srv: RubyServer): Promise<number> {
	for (let i = 0; i < 50; i++) {
		const addr = (srv as any).server.address() as { port: number } | null;
		if (addr) return addr.port;
		await new Promise((r) => setTimeout(r, 20));
	}
	throw new Error("server did not start");
}

beforeEach(async () => {
	const config: RubyConfig = {
		port: 0,
		host: "127.0.0.1",
		order: 2,
		max_length: 30,
		skip_dm: true,
		save_interval_ms: 60000,
		db_path: ":memory:",
	};
	server = new RubyServer(config);
	server.start();
	const port = await waitForServer(server);
	baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(() => {
	server.stop();
});

describe("RubyServer", () => {
	it("GET /health returns ok", async () => {
		const res = await fetch(`${baseUrl}/health`);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.status, "ok");
	});

	it("GET /stats on empty chain returns zeroes", async () => {
		const res = await fetch(`${baseUrl}/stats`);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.transitions, 0);
		assert.equal(data.starts, 0);
	});

	it("GET /channels on empty chain returns empty array", async () => {
		const res = await fetch(`${baseUrl}/channels`);
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.deepEqual(data.channels, []);
	});

	it("POST /train trains a message", async () => {
		const res = await fetch(`${baseUrl}/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello world how are you" }),
		});
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.trained, true);

		const stats = await (await fetch(`${baseUrl}/stats`)).json();
		assert.equal(stats.transitions, 3);
		assert.equal(stats.starts, 1);
	});

	it("POST /train with empty text returns 400", async () => {
		const res = await fetch(`${baseUrl}/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "" }),
		});
		assert.equal(res.status, 400);
	});

	it("POST /train-batch trains multiple messages", async () => {
		const res = await fetch(`${baseUrl}/train-batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				messages: [
					{ text: "hello world how are you" },
					{ text: "foo bar baz qux quux" },
				],
			}),
		});
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.equal(data.trained, 2);

		const stats = await (await fetch(`${baseUrl}/stats`)).json();
		assert.equal(stats.transitions, 6);
	});

	it("POST /train-batch with empty messages returns 400", async () => {
		const res = await fetch(`${baseUrl}/train-batch`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ messages: [] }),
		});
		assert.equal(res.status, 400);
	});

	it("POST /generate returns text from the chain", async () => {
		await fetch(`${baseUrl}/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello world how are you" }),
		});

		const res = await fetch(`${baseUrl}/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		assert.equal(res.status, 200);
		const data = await res.json();
		assert.ok(typeof data.text === "string");
		assert.ok(data.text.length > 0);
	});

	it("POST /generate with seed returns matching text", async () => {
		await fetch(`${baseUrl}/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "hello world how are you" }),
		});
		await fetch(`${baseUrl}/train`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text: "foo bar baz qux quux" }),
		});

		const res = await fetch(`${baseUrl}/generate`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ seed: "hello" }),
		});
		const data = await res.json();
		assert.ok(data.text.startsWith("hello world"));
	});

	it("GET /unknown returns 404", async () => {
		const res = await fetch(`${baseUrl}/unknown`);
		assert.equal(res.status, 404);
	});

	it("PUT /train returns 404", async () => {
		const res = await fetch(`${baseUrl}/train`, { method: "PUT" });
		assert.equal(res.status, 404);
	});
});
