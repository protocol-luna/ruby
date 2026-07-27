import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MarkovChain } from "./chain";
import type { RubyConfig } from "./config";

export class RubyServer {
	private server: ReturnType<typeof createServer>;
	private chain: MarkovChain;
	private config: RubyConfig;

	constructor(config: RubyConfig) {
		this.config = config;
		this.chain = new MarkovChain();
		this.server = createServer((req, res) => this.handle(req, res));
	}

	async start() {
		await this.chain.init(this.config.db_path, this.config.order);
		this.server.listen(this.config.port, this.config.host, () => {
			console.log(`[Ruby] listening on ${this.config.host}:${this.config.port}`);
		});
	}

	stop() {
		this.chain.stop();
		this.server.close();
	}

	private async handle(req: IncomingMessage, res: ServerResponse) {
		try {
			const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
			const method = req.method ?? "GET";

			if (url.pathname === "/train" && method === "POST") {
				await this.handleTrain(req, res);
			} else if (url.pathname === "/train-batch" && method === "POST") {
				await this.handleTrainBatch(req, res);
			} else if (url.pathname === "/generate" && method === "POST") {
				await this.handleGenerate(req, res);
			} else if (url.pathname === "/channels" && method === "GET") {
				this.handleChannels(res);
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

		if (typeof data.text !== "string" || !data.text.trim()) {
			return this.json(res, 400, { error: "text required" });
		}

		this.chain.train({
			text: data.text,
			isDM: data.isDM ?? false,
			channelId: data.channel_id ?? "",
			userId: data.user_id ?? "",
			platform: data.platform ?? "",
		});

		this.json(res, 200, { trained: true });
	}

	private async handleTrainBatch(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		const data = JSON.parse(body);
		const messages = data.messages;

		if (!Array.isArray(messages) || messages.length === 0) {
			return this.json(res, 400, { error: "messages array required" });
		}

		const batch = messages
			.filter((m: Record<string, unknown>) => typeof m.text === "string" && (m.text as string).trim())
			.map((m: Record<string, unknown>) => ({
				text: m.text as string,
				isDM: (m as { isDM?: boolean }).isDM ?? false,
				channelId: ((m as { channel_id?: string }).channel_id ?? "") as string,
				userId: ((m as { user_id?: string }).user_id ?? "") as string,
				platform: ((m as { platform?: string }).platform ?? "") as string,
			}));

		this.chain.trainMany(batch);
		this.chain.maybeSave();
		this.json(res, 200, { trained: batch.length });
	}

	private async handleGenerate(req: IncomingMessage, res: ServerResponse) {
		const body = await this.readBody(req);
		const data = JSON.parse(body);

		const text = this.chain.generate({
			seed: data.seed || undefined,
			maxLength: data.max_length || 30,
			channelId: data.channel_id || undefined,
		});

		this.json(res, 200, { text });
	}

	private handleChannels(res: ServerResponse) {
		this.json(res, 200, { channels: this.chain.getChannels() });
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
