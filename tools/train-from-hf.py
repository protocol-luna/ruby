#!/usr/bin/env python3
"""
Train Ruby on the HuggingFace Discord-Dialogues dataset.

Reads the local parquet file, extracts individual messages from ChatML,
and sends them to Ruby's /train-batch in batches.

Usage:
    hf download --repo-type dataset --local-dir ./hf-data mookiezi/Discord-Dialogues
    pip install pyarrow requests
    python tools/train-from-hf.py
"""

import re
import sys
import time
import requests

RUBY_URL = "http://127.0.0.1:3127"
BATCH_SIZE = 200
REPORT_EVERY = 50000

CHATML_RE = re.compile(r"<\|im_start\|>(user|assistant|system)\s(.*?)<\|im_end\|>", re.DOTALL)


def extract_messages(text: str) -> list[str]:
    """Extract individual messages from ChatML format."""
    msgs = []
    for match in CHATML_RE.finditer(text):
        role = match.group(1).strip()
        content = match.group(2).strip()
        if role != "user" and role != "assistant":
            continue
        if not content:
            continue
        msgs.append(content)
    return msgs


PARQUET_PATH = "hf-data/data/train.parquet"


def main():
    import pyarrow.parquet as pq

    print(f"Reading {PARQUET_PATH}...")
    table = pq.read_table(PARQUET_PATH, columns=["text"])
    total = table.num_rows
    print(f"Dataset has {total:,} rows ({len(table):,} after loading)")

    batch = []
    trained = 0
    skipped = 0
    start = time.time()

    for i in range(total):
        text = table["text"][i].as_py()
        msgs = extract_messages(text)

        for msg in msgs:
            if len(msg) < 5:
                skipped += 1
                continue
            batch.append({"text": msg, "platform": "discord"})

        if len(batch) >= BATCH_SIZE:
            send_batch(batch)
            trained += len(batch)
            batch = []

        if (i + 1) % REPORT_EVERY == 0:
            elapsed = time.time() - start
            rate = trained / elapsed if elapsed > 0 else 0
            print(
                f"  rows: {i+1:,} | trained: {trained:,} | "
                f"skipped: {skipped:,} | rate: {rate:.0f} msg/s",
                flush=True,
            )
            if trained > 0 and trained % 2000000 == 0:
                print(f"  checkpoint: 2M messages trained", flush=True)

    if batch:
        send_batch(batch)
        trained += len(batch)

    elapsed = time.time() - start
    print(f"\nDone! {trained:,} messages trained in {elapsed:.0f}s ({trained/elapsed:.0f} msg/s)")


def send_batch(batch: list[dict]):
    for attempt in range(10):
        try:
            resp = requests.post(
                f"{RUBY_URL}/train-batch",
                json={"messages": batch},
                timeout=60,
            )
            if resp.status_code == 200:
                return
            print(f"  [error] {resp.status_code}: {resp.text[:100]}")
        except requests.ConnectionError:
            print(f"  [error] Ruby not reachable, waiting 10s...")
            time.sleep(10)
            continue
        except Exception as e:
            print(f"  [error] {e}")
        time.sleep(2 ** min(attempt, 5))
    print(f"  [fatal] giving up after 10 attempts")
    sys.exit(1)


if __name__ == "__main__":
    main()
