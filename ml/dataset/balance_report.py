#!/usr/bin/env python3
"""Class histogram + suggested YOLO class weights YAML for rare classes."""

from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import yaml

from ml.lib import load_vision_metadata


def collect_from_split(labels_root: Path, nc: int) -> Counter:
    ctr: Counter = Counter()
    for txt in labels_root.rglob("*.txt"):
        for line in txt.read_text(encoding="utf-8", errors="ignore").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                c = int(line.split()[0])
            except (ValueError, IndexError):
                continue
            if 0 <= c < nc:
                ctr[c] += 1
    return ctr


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path, help="Split dataset root with labels/train etc.")
    ap.add_argument("--out", type=Path, default=Path("ml/runs/balance_report.json"))
    ap.add_argument("--weights-yaml", type=Path, default=Path("ml/runs/class_weights.yaml"))
    args = ap.parse_args()

    meta = load_vision_metadata()
    nc = int(meta["nc"])
    names = meta["names"]

    ctr = collect_from_split(args.dataset / "labels", nc)
    total = sum(ctr.values()) or 1
    freq = [ctr.get(i, 0) / total for i in range(nc)]
    pos = [f for f in freq if f > 0]
    pos.sort()
    median = pos[len(pos) // 2] if pos else 1e-3
    weights = []
    for i in range(nc):
        f = max(freq[i], 1e-6)
        w = median / f
        weights.append(round(min(4.0, max(0.5, w)), 4))

    rare_thr = 0.03
    report = {
        "nc": nc,
        "names": names,
        "counts": {names[i]: ctr.get(i, 0) for i in range(nc)},
        "fraction": {names[i]: round(freq[i], 5) for i in range(nc)},
        "rare_under": rare_thr,
        "suggested_weights": {names[i]: weights[i] for i in range(nc)},
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, indent=2), encoding="utf-8")

    args.weights_yaml.parent.mkdir(parents=True, exist_ok=True)
    args.weights_yaml.write_text(yaml.dump({"class_weights": weights}, default_flow_style=True), encoding="utf-8")
    print("Wrote", args.out, "and", args.weights_yaml)


if __name__ == "__main__":
    main()
