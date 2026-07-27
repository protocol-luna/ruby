<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="images/logo.webp">
    <img src="images/logo.webp" alt="Ruby" width="200" style="border-radius: 20px;">
  </picture>
  <h1 align="center">Ruby</h1>
  <p align="center">Markov chain service for the Luna Protocol ecosystem</p>
  <p align="center">
    <a href="https://github.com/protocol-luna/ruby/blob/main/LICENSE">
      <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square" alt="License">
    </a>
    <a href="https://www.typescriptlang.org/">
      <img src="https://img.shields.io/badge/language-TypeScript-3178C6?style=flat-square" alt="Language">
    </a>
    <a href="https://github.com/protocol-luna">
      <img src="https://img.shields.io/badge/part%20of-Luna%20Protocol-9370DB?style=flat-square" alt="Luna Protocol">
    </a>
  </p>
</p>

Ruby generates spontaneous, context-free messages by recombining real messages from Discord and Matrix channels — no LLM inference needed. It's an order-2 Markov chain stored in SQLite.

```mermaid
graph LR
    Emerald["Emerald<br/>Brain"] -- "trains on all messages" --> Ruby["Ruby<br/><strong>Markov Chain</strong>"]
    Emerald -- "HTTP :3127 /generate" --> Ruby
```

## How It Works

1. Every message that flows through Emerald is forwarded to Ruby's `/train` endpoint (fire-and-forget)
2. Ruby tokenizes and builds an order-2 Markov chain in SQLite: each pair of words maps to possible next words
3. Messages are tagged with `channel_id` — the chain can be filtered by source channel
4. When Emerald decides to be spontaneous (or triggers a `random`/`spontaneous` response), it calls Ruby's `/generate`
5. Ruby samples the chain with weighted random selection and returns a sentence
6. Emerald applies the same behavior pipeline as any response (delay, hesitation, burst, typos)

## Technical Overview

Ruby is **~400 lines of TypeScript** across 4 source files. It uses **sql.js** (SQLite compiled to WebAssembly) for persistence and Node.js built-in `http` module for the server — no external HTTP framework.

### Source Map

| File | Lines | Role |
|------|-------|------|
| `src/index.ts` | 27 | Entry point, signal handlers |
| `src/config.ts` | 39 | YAML config loader |
| `src/chain.ts` | 225 | Core Markov chain + SQLite |
| `src/server.ts` | 131 | HTTP server (6 endpoints) |
| `tools/train-from-hf.py` | 104 | Bulk train from HuggingFace dataset |

### Markov Chain Implementation (`src/chain.ts`, 225 lines)

**Database schema:**

```sql
-- Order-2 prefix→suffix mapping
CREATE TABLE transitions (
  prefix TEXT,       -- two words joined by \x00, e.g. "hello\x00world"
  suffix TEXT,       -- the next word
  count INTEGER,     -- frequency (incremented on repeat)
  channel_id TEXT,   -- source channel ("" for cross-channel aggregate)
  PRIMARY KEY (prefix, suffix, channel_id)
);

-- Valid sentence starters
CREATE TABLE starters (
  prefix TEXT,       -- first two-word pair of a message
  channel_id TEXT,
  PRIMARY KEY (prefix, channel_id)
);

CREATE INDEX idx_trans_prefix ON transitions(prefix);
```

**Training (`train()`):**
1. Tokenizes text: strips URLs, Discord mentions (`<@!?\d+>`), custom emoji, non-word characters. Splits on whitespace.
2. Requires ≥3 words
3. First pair → inserted into `starters` (INSERT OR IGNORE)
4. Each sliding window of 2 words → next word inserted/summed into `transitions` (upsert pattern)

**Generation (`generate()`):**
1. Pick a starting prefix: random from `starters`, or filtered by `seed` (SQL `LIKE` match on lowercased seed + `%`)
2. Start with the first two words
3. Loop up to `maxLength` (default 30):
   - Query `transitions` for all suffixes matching current 2-word prefix
   - **Weighted random selection:** sum all counts, roll in `[0, total)`, subtract each count until roll hits zero
   - If no transition found, stop
   - Append suffix to result, slide window
4. Return joined words

**Persistence:** The entire SQLite database is kept in memory (sql.js is WASM-based, no native bindings). Every `save_interval_ms` (default 60s), `db.export()` writes a complete binary snapshot to disk via `writeFileSync`. On stop, a final save flushes all data.

### API Endpoints

#### `POST /train`
Train a single message.
```json
{ "text": "hello everyone how are you", "channel_id": "123", "isDM": false }
```
Response: `200 { "trained": true }`

#### `POST /train-batch`
Train multiple messages atomically (SQL transaction).
```json
{ "messages": [{ "text": "...", "channel_id": "..." }, ...] }
```
Response: `200 { "trained": <count> }`

#### `POST /generate`
Generate a message. All fields optional.
```json
{ "seed": "how", "max_length": 30, "channel_id": "123" }
```
Response: `200 { "text": "how are you doing today" }`

#### `GET /channels`
List all known channel IDs.
Response: `200 { "channels": ["123", "456"] }`

#### `GET /stats`
Chain statistics.
Response: `200 { "transitions": 423, "starts": 87 }`

#### `GET /health`
Health check.
Response: `200 { "status": "ok" }`

### Tokenization (`tokenize()`)

```typescript
1. Strip URLs: https?://\S+
2. Strip Discord mentions: <@!?\d+>
3. Strip custom emoji: <a?:\w+:\d+>
4. Strip non-word/accented chars (keep a-z, A-Z, 0-9, _, whitespace, apostrophes)
5. Split on whitespace, filter empty
```

### Configuration

```yaml
port: 3127
host: "127.0.0.1"
order: 2          # Markov chain order
max_length: 30    # Max generated words
skip_dm: true     # Skip DM messages in training
save_interval_ms: 60000  # SQLite persist interval
db_path: "chain.db"
```

### Integration with Emerald

Ruby is wired via `emerald/src/ruby-client.ts`:
- **Training:** Every non-self message Emerald sees → fire-and-forget `POST /train`
- **Generation:** When trigger reason matches `ruby_reasons` config (default: `["random", "spontaneous"]`), Emerald generates via Ruby instead of Sapphire/LLM
- **Seed:** The last 2 words of the user's message are used as the generation seed
- **Post-processing:** Ruby output goes through Emerald's full behavior pipeline (delay, hesitation, burst, typos)

This gives the bot occasional "ambient" messages at near-zero latency compared to LLM inference.

### Bulk Training from HuggingFace

```bash
pip install datasets requests
python tools/train-from-hf.py
```

Downloads and processes `mookiezi/Discord-Dialogues` dataset, batching 500 messages per request via `/train-batch`.

## Running

```bash
npm install
npm run build    # esbuild → self-cli.cjs
npm run start    # node self-cli.cjs
npm run dev      # tsx watch

# With PM2
pm2 start self-cli.cjs --interpreter node --name ruby
pm2 save
```
