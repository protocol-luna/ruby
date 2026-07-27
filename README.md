# Ruby

Ruby is the Markov chain service for the Luna Protocol ecosystem. It generates spontaneous, context-free messages by recombining real messages from Discord and Matrix channels — no LLM inference needed.

> **Architecture**: `Emerald (decision) → Ruby (HTTP) ← trains on all messages Emerald sees`

## How It Works

1. Every message that flows through Emerald is forwarded to Ruby's `/train` endpoint (fire-and-forget)
2. Ruby tokenizes and builds an order-2 Markov chain: each pair of words maps to possible next words
3. When Emerald decides to be spontaneous (or triggers a `random`/`keyword` response), it calls Ruby's `/generate`
4. Ruby samples the chain with weighted random selection and returns a sentence
5. Emerald applies the same behavior pipeline as any response (delay, hesitation, burst, typos)

## Components

- **`src/chain.ts`** — Core Markov chain: order-2 prefix map with weighted suffix sampling, automatic JSON persistence
- **`src/server.ts`** — HTTP server with routes for training, generation, stats, and health checks
- **`src/config.ts`** — YAML-based configuration

## API

### `POST /train`

Feed a message into the chain.

```json
{ "text": "hello everyone how are you", "isDM": false }
```

### `POST /generate`

Generate a message from the chain.

```json
{ "seed": "how", "max_length": 30 }
```

Returns `{ "text": "how are you doing today" }`.

### `GET /stats`

Returns chain statistics: `{ entries, starts, words, order }`.

## Configuration

```yaml
port: 3127
host: "127.0.0.1"
order: 2
max_length: 30
skip_dm: true
save_interval_ms: 60000
chain_path: "chain.json"
```

## Running

```bash
npm install
npm run build    # esbuild → self-cli.cjs
npm run start    # node self-cli.cjs
npm run dev      # tsx watch
```

With PM2:

```bash
pm2 start self-cli.cjs --interpreter node --name ruby
pm2 save
```

## Integration with Emerald

Ruby is wired into Emerald via `emerald/src/ruby-client.ts`. When `ruby_enabled: true` in Emerald's config, every message is silently trained into Ruby, and triggers with reasons in `ruby_reasons` (default: `["random", "spontaneous"]`) use Ruby instead of Sapphire/LLM.
