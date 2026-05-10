#!/usr/bin/env python3
"""Append a training/export record to ml/versioning/model_registry.jsonl (append-only audit)."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.lib import load_vision_metadata


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--metrics", type=Path, help="metrics_summary.json from train_yolov8")
    ap.add_argument("--export-registry", type=Path, help="export_registry.json from export_models")
    ap.add_argument("--dataset-hash", type=str, default="", help="git hash or digest of dataset manifest")
    args = ap.parse_args()

    reg_path = ROOT / "ml" / "versioning" / "model_registry.jsonl"
    reg_path.parent.mkdir(parents=True, exist_ok=True)

    meta = load_vision_metadata()
    row = {
        "ts": int(time.time()),
        "schema": 1,
        "metadata_schema": meta.get("schema_version"),
        "nc": meta["nc"],
        "names": meta["names"],
        "dataset_hash": args.dataset_hash or None,
        "training": json.loads(args.metrics.read_text(encoding="utf-8")) if args.metrics and args.metrics.is_file() else None,
        "export": json.loads(args.export_registry.read_text(encoding="utf-8")) if args.export_registry and args.export_registry.is_file() else None,
    }
    with reg_path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(row, ensure_ascii=False) + "\n")
    print("Appended to", reg_path)


if __name__ == "__main__":
    main()
