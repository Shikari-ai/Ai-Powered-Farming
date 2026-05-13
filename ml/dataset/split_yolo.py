#!/usr/bin/env python3
"""Stratified split of flat YOLO folder → train/val/test with images + labels."""

from __future__ import annotations

import argparse
import random
import shutil
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import yaml

from ml.lib import load_vision_metadata

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def dominant_class_from_label(txt: Path) -> int:
    if not txt.is_file():
        return -1
    best = None
    for line in txt.read_text(encoding="utf-8", errors="ignore").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if not parts:
            continue
        try:
            c = int(parts[0])
            best = c
            break
        except ValueError:
            continue
    return best if best is not None else -1


def find_image_path(img_dir: Path, stem: str) -> Path | None:
    for ext in IMG_EXT:
        p = img_dir / f"{stem}{ext}"
        if p.is_file():
            return p
    return None


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path, help="Source with images/ labels/")
    ap.add_argument("out", type=Path, help="Output root (created)")
    ap.add_argument("--policy", type=Path, default=None)
    args = ap.parse_args()

    policy_path = args.policy or (ROOT / "ml" / "config" / "dataset_policy.yaml")
    with policy_path.open("r", encoding="utf-8") as f:
        policy = yaml.safe_load(f) or {}
    sp = policy.get("splits", {})
    tr = float(sp.get("train_ratio", 0.78))
    va = float(sp.get("val_ratio", 0.12))
    te = float(sp.get("test_ratio", 0.10))
    seed = int(sp.get("seed", 42))
    assert abs(tr + va + te - 1.0) < 1e-6

    meta = load_vision_metadata()
    nc = int(meta["nc"])

    img_dir = args.dataset / "images"
    lbl_dir = args.dataset / "labels"
    stems: list[tuple[str, int]] = []
    for p in sorted(img_dir.iterdir()):
        if p.suffix.lower() not in IMG_EXT:
            continue
        dom = dominant_class_from_label(lbl_dir / f"{p.stem}.txt")
        if dom < 0 or dom >= nc:
            dom = nc  # bucket unknown into last for stratify
        stems.append((p.stem, dom))

    by_bucket: dict[int, list[str]] = defaultdict(list)
    for stem, d in stems:
        by_bucket[d].append(stem)

    rnd = random.Random(seed)
    train_s, val_s, test_s = [], [], []
    for _, group in by_bucket.items():
        rnd.shuffle(group)
        n = len(group)
        nt = int(round(n * tr))
        nv = int(round(n * va))
        train_s.extend(group[:nt])
        val_s.extend(group[nt : nt + nv])
        test_s.extend(group[nt + nv :])

    for split_name, group in ("train", train_s), ("val", val_s), ("test", test_s):
        (args.out / "images" / split_name).mkdir(parents=True, exist_ok=True)
        (args.out / "labels" / split_name).mkdir(parents=True, exist_ok=True)
        for stem in group:
            ip = find_image_path(img_dir, stem)
            if not ip:
                continue
            shutil.copy2(ip, args.out / "images" / split_name / ip.name)
            lp = lbl_dir / f"{stem}.txt"
            if lp.is_file():
                shutil.copy2(lp, args.out / "labels" / split_name / f"{stem}.txt")

    print("train", len(train_s), "val", len(val_s), "test", len(test_s), "→", args.out)


if __name__ == "__main__":
    main()
