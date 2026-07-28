import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { MarkovChain } from "../src/chain";

let chain: MarkovChain;

beforeEach(() => {
	chain = new MarkovChain();
	chain.init(":memory:", 2);
});

afterEach(() => {
	chain.close();
});

describe("MarkovChain", () => {
	it("init creates an empty chain", () => {
		const stats = chain.getStats();
		assert.equal(stats.transitions, 0);
		assert.equal(stats.starts, 0);
	});

	it("train adds transitions and starter", () => {
		chain.train({ text: "hello world how are you" });
		const stats = chain.getStats();
		assert.equal(stats.transitions, 3);
		assert.equal(stats.starts, 1);
	});

	it("train skips DMs", () => {
		chain.train({ text: "hello world how are you", isDM: true });
		assert.equal(chain.getStats().transitions, 0);
	});

	it("train skips messages below order+1 words", () => {
		chain.train({ text: "hello world" });
		assert.equal(chain.getStats().transitions, 0);
	});

	it("train with channelId scopes entries per channel", () => {
		chain.train({ text: "hello world how are you", channelId: "ch1" });
		chain.train({ text: "foo bar baz qux quux", channelId: "ch2" });
		assert.equal(chain.getStats().transitions, 6);
		assert.equal(chain.getStats().starts, 2);
	});

	it("generate returns empty string for empty chain", () => {
		assert.equal(chain.generate(), "");
	});

	it("generate returns text from trained chain", () => {
		chain.train({ text: "hello world how are you" });
		const result = chain.generate();
		assert.ok(result.length > 0);
		const words = result.split(" ");
		for (const word of words) {
			assert.ok(
				["hello", "world", "how", "are", "you"].includes(word),
				`unexpected word "${word}" in "${result}"`,
			);
		}
	});

	it("generate with seed matching starter uses that prefix", () => {
		chain.train({ text: "hello world how are you" });
		chain.train({ text: "foo bar baz qux quux" });
		const result = chain.generate({ seed: "hello" });
		assert.ok(result.startsWith("hello world"));
	});

	it("generate with maxLength limits output length", () => {
		const msg = "a b c d e f g h i j k l m n o p";
		chain.train({ text: msg });
		const result = chain.generate({ maxLength: 5 });
		assert.ok(result.split(" ").length <= 7); // order(2) + maxLength(5)
	});

	it("generate with channelId only uses entries from that channel", () => {
		chain.train({ text: "hello world how are you", channelId: "ch1" });
		chain.train({ text: "foo bar baz qux quux", channelId: "ch1" });
		chain.train({ text: "alpha beta gamma delta epsilon", channelId: "ch2" });
		const result = chain.generate({ channelId: "ch2" });
		const words = result.split(" ");
		for (const word of words) {
			assert.ok(
				["alpha", "beta", "gamma", "delta", "epsilon"].includes(word),
				`word "${word}" from wrong channel`,
			);
		}
	});

	it("trainMany processes all messages", () => {
		chain.trainMany([
			{ text: "hello world how are you" },
			{ text: "foo bar baz qux quux" },
		]);
		assert.equal(chain.getStats().transitions, 6);
		assert.equal(chain.getStats().starts, 2);
	});

	it("trainMany skips DMs", () => {
		chain.trainMany([
			{ text: "hello world how are you", isDM: true },
			{ text: "foo bar baz qux quux" },
		]);
		assert.equal(chain.getStats().transitions, 3);
	});

	it("getChannels returns distinct channel IDs", () => {
		chain.train({ text: "hello world how are you", channelId: "ch1" });
		chain.train({ text: "foo bar baz qux quux", channelId: "ch2" });
		const channels = chain.getChannels();
		assert.equal(channels.length, 2);
		assert.ok(channels.includes("ch1"));
		assert.ok(channels.includes("ch2"));
	});

	it("tokenize strips URLs", () => {
		chain.train({ text: "hello world https://example.com/path how are you" });
		const result = chain.generate();
		assert.ok(!result.includes("https"));
		assert.ok(!result.includes("example"));
	});

	it("tokenize strips Discord mentions", () => {
		chain.train({
			text: "hello <@!123456789> world how are you",
		});
		const result = chain.generate();
		assert.ok(!result.includes("@"));
	});

	it("tokenize strips custom emoji", () => {
		chain.train({
			text: "hello world <:smile:123456> how are you",
		});
		const result = chain.generate();
		assert.ok(!result.includes("smile"));
	});

	it("close on uninitialized chain does not throw", () => {
		const c = new MarkovChain();
		assert.doesNotThrow(() => c.close());
	});

	it("different order creates different chain structure", () => {
		const bigOrder = new MarkovChain();
		bigOrder.init(":memory:", 3);
		// order=3: each prefix is 3 words
		bigOrder.train({
			text: "hello world how are you doing today",
		});
		// Words: ["hello", "world", "how", "are", "you", "doing", "today"]
		// order=3, need 4+ words (7 >= 4 ✓)
		// starters: "hello\x00world\x00how"
		// transitions: 
		//   "hello\x00world\x00how" → "are"
		//   "world\x00how\x00are" → "you"
		//   "how\x00are\x00you" → "doing"
		//   "are\x00you\x00doing" → "today"
		// = 4 transitions, 1 starter
		assert.equal(bigOrder.getStats().transitions, 4);
		assert.equal(bigOrder.getStats().starts, 1);
		bigOrder.close();
	});

	it("generate with seed that doesn't match returns empty", () => {
		chain.train({ text: "hello world how are you" });
		const result = chain.generate({ seed: "zzzzz" });
		assert.equal(result, "");
	});
});
