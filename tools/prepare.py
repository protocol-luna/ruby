#!/usr/bin/env python3
"""Pre-extract individual messages from Discord-Dialogues ChatML parquet.

Uses all CPUs in parallel to extract messages once, saving to a gzipped
text file (one message per line) for fast re-training later.

Usage:
    python tools/prepare.py
"""

import gzip
import re
import time
from multiprocessing import Process

import pyarrow.parquet as pq

PARQUET_PATH = "hf-data/data/train.parquet"
OUTPUT_PATH = "hf-data/messages.txt.gz"
NUM_WORKERS = 4

CHATML_RE = re.compile(r"<\|im_start\|>(user|assistant|system)\s(.*?)<\|im_end\|>", re.DOTALL)


def extract_messages(text: str) -> list[str]:
    msgs = []
    for match in CHATML_RE.finditer(text):
        role = match.group(1).strip()
        content = match.group(2).strip()
        if role != "user" and role != "assistant":
            continue
        if not content or len(content) < 5:
            continue
        msgs.append(content)
    return msgs


def worker(worker_id: int, row_groups: list[int], tmp_dir: str):
    tmp_path = f"{tmp_dir}/worker-{worker_id}.txt.gz"
    pf = pq.ParquetFile(PARQUET_PATH)
    count = 0
    start = time.time()

    for rg in row_groups:
        table = pf.read_row_group(rg, columns=["text"])
        for i in range(table.num_rows):
            text = table["text"][i].as_py()
            msgs = extract_messages(text)
            if not msgs:
                continue

            with gzip.open(tmp_path, "ab") as f:
                f.write(("\n".join(msgs) + "\n").encode())

            count += len(msgs)
            if count % 200000 == 0:
                elapsed = time.time() - start
                print(
                    f"  [w{worker_id}] {count:,} msgs extracted ({count/elapsed:.0f} msg/s)",
                    flush=True,
                )

    elapsed = time.time() - start
    print(f"  [w{worker_id}] done: {count:,} msgs in {elapsed:.0f}s", flush=True)


def main():
    import os
    import shutil

    print(f"Opening {PARQUET_PATH}...")
    pf = pq.ParquetFile(PARQUET_PATH)
    num_rg = pf.metadata.num_row_groups
    print(f"Dataset: {pf.metadata.num_rows:,} rows in {num_rg} row groups")

    tmp_dir = "hf-data/tmp_prepare"
    os.makedirs(tmp_dir, exist_ok=True)

    all_rgs = list(range(num_rg))
    chunks = [[] for _ in range(NUM_WORKERS)]
    for i, rg in enumerate(all_rgs):
        chunks[i % NUM_WORKERS].append(rg)

    procs = []
    for wid in range(NUM_WORKERS):
        p = Process(target=worker, args=(wid, chunks[wid], tmp_dir))
        procs.append(p)

    start = time.time()
    for p in procs:
        p.start()
    for p in procs:
        p.join()

    # Merge temp files
    print("Merging...")
    with gzip.open(OUTPUT_PATH, "wb") as out:
        for wid in range(NUM_WORKERS):
            tmp_path = f"{tmp_dir}/worker-{wid}.txt.gz"
            if os.path.exists(tmp_path):
                with gzip.open(tmp_path, "rb") as f:
                    shutil.copyfileobj(f, out)
                os.remove(tmp_path)
    os.rmdir(tmp_dir)

    elapsed = time.time() - start
    size = os.path.getsize(OUTPUT_PATH)
    total = 0
    with gzip.open(OUTPUT_PATH, "rt") as f:
        for _ in f:
            total += 1
    print(f"\nDone! {total:,} msgs in {OUTPUT_PATH} ({size/1024/1024:.1f} MB)")
    print(f"Time: {elapsed:.0f}s ({total/elapsed:.0f} msg/s)")


if __name__ == "__main__":
    main()
