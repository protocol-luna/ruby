#!/usr/bin/env python3
"""
Train Ruby from pre-extracted messages file.

Reads hf-data/messages.txt.gz (one message per line) and sends to Ruby
in batches. Saves a checkpoint so restarting skips already-trained messages.

Usage:
    python tools/prepare.py          # first: extract messages from parquet
    python tools/train-from-hf.py    # train Ruby
"""

import gzip
import os
import sys
import time

import requests

RUBY_URL = "http://127.0.0.1:3127"
MESSAGES_PATH = "hf-data/messages.txt.gz"
CHECKPOINT_PATH = "hf-data/train-checkpoint.txt"
BATCH_SIZE = 20000


def load_checkpoint() -> int:
    if os.path.exists(CHECKPOINT_PATH):
        with open(CHECKPOINT_PATH) as f:
            return int(f.read().strip())
    return 0


def save_checkpoint(line: int):
    tmp = CHECKPOINT_PATH + ".tmp"
    with open(tmp, "w") as f:
        f.write(str(line))
    os.replace(tmp, CHECKPOINT_PATH)


def main(total: int):
    if not os.path.exists(MESSAGES_PATH):
        print(f"Run 'python tools/prepare.py' first to create {MESSAGES_PATH}")
        sys.exit(1)

    skip = load_checkpoint()
    if skip > 0:
        print(f"Resuming from line {skip:,} / {total:,} ({skip/total*100:.1f}%)")

    session = requests.Session()
    batch = []
    trained = 0
    line_num = 0
    start = time.time()

    with gzip.open(MESSAGES_PATH, "rt", errors="replace") as f:
        for line in f:
            line = line.strip()
            line_num += 1
            if not line or line_num <= skip:
                continue

            batch.append({"text": line, "platform": "discord"})

            if len(batch) >= BATCH_SIZE:
                ok = send_batch(session, batch)
                if not ok:
                    sys.exit(1)
                trained += len(batch)
                save_checkpoint(line_num)
                batch = []

                elapsed = time.time() - start
                rate = trained / elapsed if elapsed > 0 else 0
                remaining = total - skip - trained
                eta = remaining / rate if rate > 0 else 0
                print(
                    f"  {trained:,} / {total:,} msgs | "
                    f"{rate:.0f} msg/s | ETA: {eta/60:.0f} min",
                    flush=True,
                )

    if batch:
        ok = send_batch(session, batch)
        if ok:
            trained += len(batch)
            save_checkpoint(line_num)

    elapsed = time.time() - start
    print(f"\nDone! {trained:,} messages trained in {elapsed:.0f}s ({trained/elapsed:.0f} msg/s)")


def send_batch(session: requests.Session, batch: list[dict]) -> bool:
    for attempt in range(20):
        try:
            resp = session.post(
                f"{RUBY_URL}/train-batch",
                json={"messages": batch},
                timeout=120,
            )
            if resp.status_code == 200:
                return True
            print(f"  [error] {resp.status_code}: {resp.text[:100]}", flush=True)
        except requests.ConnectionError:
            print(f"  [error] Ruby not reachable, reconnecting...", flush=True)
            session.close()
            session = requests.Session()
            time.sleep(2)
            continue
        except Exception as e:
            print(f"  [error] {e}", flush=True)
        time.sleep(2 ** min(attempt, 5))
    print(f"  [fatal] giving up after 20 attempts", flush=True)
    return False


if __name__ == "__main__":
    total = 0
    with gzip.open(MESSAGES_PATH, "rt") as f:
        for _ in f:
            total += 1
    print(f"Total messages in file: {total:,}")
    main(total)
