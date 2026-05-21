#!/usr/bin/env python3
"""
Convert a YOLO detection dataset (split by run_pipeline.py) into an image
classification dataset for AgroNet training.

Each image gets a single class label = dominant detection in its YOLO label file.
Also writes a health_scores.yaml mapping image stem → synthesised health score
derived from disease_kb.yaml health_score_base values.

Output layout:
    <out>/
      train/<class_name>/<img>
      val/<class_name>/<img>
      test/<class_name>/<img>    (if present in input)
      health_scores.yaml

Usage:
    python -m ml.dataset.prepare_classification \
        --split-dir  ml/runs/pipeline/run_xxx/split \
        --out        ml/runs/pipeline/run_xxx/clf_dataset
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.models.agro_net import AGRO_CLASSES, CLASS_HEALTH_BASE

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("prepare_clf")


def _dominant_class(label_path: Path) -> int | None:
    """Return class index that appears most in YOLO label file (or None)."""
    counts: dict[int, int] = {}
    try:
        for line in label_path.read_text(encoding="utf-8").splitlines():
            parts = line.strip().split()
            if not parts:
                continue
            idx = int(parts[0])
            counts[idx] = counts.get(idx, 0) + 1
    except Exception:
        return None
    if not counts:
        return None
    return max(counts, key=lambda k: counts[k])


def convert_split(
    images_dir: Path,
    labels_dir: Path,
    out_dir: Path,
    health_map: dict,
    split_name: str,
) -> int:
    skipped = 0
    converted = 0

    for img in sorted(images_dir.iterdir()):
        if img.suffix.lower() not in {".jpg", ".jpeg", ".png", ".bmp"}:
            continue
        lbl = labels_dir / (img.stem + ".txt")
        if not lbl.is_file():
            skipped += 1
            continue
        cls_idx = _dominant_class(lbl)
        if cls_idx is None or cls_idx >= len(AGRO_CLASSES):
            skipped += 1
            continue

        class_name = AGRO_CLASSES[cls_idx]
        dest_dir = out_dir / class_name
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / img.name
        shutil.copy2(img, dest)

        # Build health score for this image
        base_score = CLASS_HEALTH_BASE.get(class_name, 55)
        # Add small random-ish variance based on filename hash so different
        # images of the same class get slightly different scores (±8 pts)
        import hashlib
        h = int(hashlib.md5(img.name.encode()).hexdigest(), 16)
        variance = (h % 17) - 8  # -8 to +8
        score = max(0, min(100, base_score + variance))
        health_map[img.stem] = score
        converted += 1

    log.info("%s: %d converted, %d skipped", split_name, converted, skipped)
    return converted


def main() -> None:
    ap = argparse.ArgumentParser(description="Convert YOLO split dataset → AgroNet classification format")
    ap.add_argument("--split-dir", type=Path, required=True, help="Root of YOLO split (contains train/val/test)")
    ap.add_argument("--out", type=Path, required=True, help="Output classification dataset directory")
    args = ap.parse_args()

    split_dir = args.split_dir
    out = args.out
    out.mkdir(parents=True, exist_ok=True)

    health_map: dict = {}
    total = 0

    for split in ["train", "val", "test"]:
        img_dir = split_dir / split / "images"
        lbl_dir = split_dir / split / "labels"
        if not img_dir.is_dir():
            continue
        split_out = out / split
        split_out.mkdir(parents=True, exist_ok=True)
        n = convert_split(img_dir, lbl_dir, split_out, health_map, split)
        total += n

    # Save health scores
    health_yaml = out / "health_scores.yaml"
    health_yaml.write_text(yaml.dump(health_map, default_flow_style=False), encoding="utf-8")

    log.info("Done. Total: %d images → %s", total, out)
    log.info("Health scores → %s", health_yaml)

    # Print class distribution
    class_counts: dict[str, int] = {}
    for split in ["train", "val", "test"]:
        for cls_dir in (out / split).iterdir() if (out / split).is_dir() else []:
            if cls_dir.is_dir():
                class_counts[cls_dir.name] = class_counts.get(cls_dir.name, 0) + len(list(cls_dir.iterdir()))
    log.info("Class distribution: %s", class_counts)


if __name__ == "__main__":
    main()
