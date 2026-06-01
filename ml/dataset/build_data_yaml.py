#!/usr/bin/env python3
"""Write Ultralytics data.yaml for a split YOLO dataset."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import yaml

from ml.lib import load_vision_metadata


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset_root", type=Path, help="Split output with images/train,val,test")
    ap.add_argument("--out", type=Path, default=None, help="data.yaml path (default: dataset_root/data.yaml)")
    args = ap.parse_args()

    root = args.dataset_root.resolve()
    out = args.out or (root / "data.yaml")
    meta = load_vision_metadata()
    doc = {
        "path": str(root).replace("\\", "/"),
        "train": "images/train",
        "val": "images/val",
        "test": "images/test",
        "nc": meta["nc"],
        "names": meta["names"],
    }
    out.write_text(yaml.dump(doc, sort_keys=False), encoding="utf-8")
    print("Wrote", out)


if __name__ == "__main__":
    main()
