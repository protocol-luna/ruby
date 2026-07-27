import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MarkovChain } from "./chain";
import type { RubyConfig } from "./config";

export class RubyServer {
	private server: ReturnType<typeof createServer>;
	private chain: MarkovChain;
	private config: RubyConfig;

	constructor(config: RubyConfig) {
		this.config = config;
		this.chain = new MarkovChain(config.order, config.chain_path);
		this.server = createServer((req, res) => this.handle(req, res));
	}

	start() {
		this.chain.start();
		this.server.listen(this.config.port, this.config.host, () => {
			console.log(`[Ruby] listening on ${this.config.host}:${this.config.port}`);
		});
	}

	stop() {
		this.chain.stop();
		this.server.close();
	}

	getChain() {
		return this.chain;
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			const method = req.method ?? "GET";

			if (url.pathname === "/train" && method === "POST") {
				await this.handleTrain(req, res);
			} else if (url.pathname === "/generate" && method === "POST") {
				await this.handleGenerate(req, res);
			} else if (url.pathname === "/stats" && method === "GET") {
				this.handleStats(res);
			} else if (url.pathname === "/health" && method === "GET") {
				this.json(res, 200, { status: "ok" });
			} else {
				this.json(res, 404, { error: "not found" });
			}
		} catch (err) {
			console.error("[Ruby] request error:", err);
			this.json(res, 500, { error: "internal error" });
		}
	}

	private async handleTrain(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		const data = JSON.parse(body);
		const text = data.text;
		const isDM = data.isDM ?? false;

		if (typeof text !== "string" || !text.trim()) {
			return this.json(res, 400, { error: "text required" });
		}

		if (isDM) {
			return this.json(res, 200, { trained: false, reason: "dm_skipped" });
		}

		this.chain.train(text);
		this.json(res, 200, { trained: true });
	}

	private async handleGenerate(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		const data = JSON.parse(body);

		const text = this.chain.generate({
			seed: data.seed || undefined,
			maxLength: data.max_length || 30,
		});

		this.json(res, 200, { text });
	}

	private handleStats(res: ServerResponse) {
		this.json(res, 200, this.chain.getStats());
	}

	private readBody(req: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			req.on("data", (c: Buffer) => chunks.push(c));
			req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
			req.on("error", reject);
		});
	}

	private json(res: ServerResponse, status: number, data: unknown) {
		res.writeHead(status, { "Content-Type": "application/json" });
		res.end(JSON.stringify(data));
	}
}
