#!/usr/bin/env python3
"""
Master dataset builder — orchestrates the full data collection and
preparation pipeline for AgroNet training.

Steps
─────
1. download   — Pull PlantVillage from HuggingFace
2. collect    — Scrape per-class images from DuckDuckGo
3. merge      — Combine both sources into one flat directory per class
4. deduplicate— SHA-256 + pHash to remove exact/near duplicates
5. quality    — Filter blurry, over/underexposed, too-small images
6. split      — Stratified 80/10/10 train/val/test
7. report     — Print final class distribution table

Output:
    <workdir>/
      raw/plantvillage/<class>/   (from step 1)
      raw/web/<class>/            (from step 2)
      merged/<class>/             (step 3)
      clean/<class>/              (step 5)
      split/train|val|test/<class>/  (step 6)
      dataset_report.json         (step 7)

Usage:
    python -m ml.dataset.build_full_dataset \
        --workdir ml/data \
        --epochs  60          # passed through to train_agronet if --train flag set

    # Skip already-done steps:
    python -m ml.dataset.build_full_dataset --workdir ml/data --from-step split
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import random
import shutil
import sys
import time
from pathlib import Path
from typing import Optional

log = logging.getLogger("build_dataset")

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

AGRO_CLASSES = [
    "leaf_rust", "early_blight", "late_blight", "powdery_mildew",
    "bacterial_spot", "nitrogen_deficiency", "potassium_deficiency",
    "healthy_leaf", "pest_damage", "general_lesion",
]

STEPS = ["download", "collect", "merge", "deduplicate", "quality", "split", "report"]

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


# ── Deduplication ─────────────────────────────────────────────────────────────

def _sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while True:
            buf = f.read(1 << 20)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()


def _phash(p: Path) -> Optional[int]:
    try:
        import cv2, numpy as np
        img = cv2.imread(str(p), cv2.IMREAD_GRAYSCALE)
        if img is None:
            return None
        small = cv2.resize(img, (32, 32))
        mean  = small.mean()
        bits  = (small > mean).flatten()
        value = 0
        for b in bits[:64]:
            value = (value << 1) | int(b)
        return value
    except Exception:
        return None


def _hamming(a: int, b: int) -> int:
    return bin(a ^ b).count("1")


def deduplicate_dir(cls_dir: Path, hamming_threshold: int = 6) -> tuple[int, int]:
    """Remove SHA-256 exact duplicates and pHash near-duplicates. Returns (kept, removed)."""
    images = sorted(p for p in cls_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
    sha_seen:   set[str]  = set()
    phash_seen: list[int] = []
    removed = 0

    for img in images:
        sha = _sha256(img)
        if sha in sha_seen:
            img.unlink(missing_ok=True)
            removed += 1
            continue
        sha_seen.add(sha)

        ph = _phash(img)
        if ph is not None:
            if any(_hamming(ph, h) <= hamming_threshold for h in phash_seen):
                img.unlink(missing_ok=True)
                removed += 1
                continue
            phash_seen.append(ph)

    kept = len(images) - removed
    return kept, removed


# ── Quality filtering ─────────────────────────────────────────────────────────

def quality_filter_dir(src: Path, dst: Path) -> tuple[int, int]:
    from ml.dataset.quality import assess_image
    dst.mkdir(parents=True, exist_ok=True)
    images  = [p for p in src.iterdir() if p.suffix.lower() in IMAGE_EXTS]
    kept    = rejected = 0
    for img in images:
        result = assess_image(img, min_edge=160)
        if result.ok:
            shutil.copy2(img, dst / img.name)
            kept += 1
        else:
            rejected += 1
    return kept, rejected


# ── Split ─────────────────────────────────────────────────────────────────────

def stratified_split(clean_root: Path, split_root: Path,
                     ratios: tuple = (0.80, 0.10, 0.10),
                     seed: int = 42) -> dict:
    rng = random.Random(seed)
    report: dict[str, dict[str, int]] = {}

    for cls_dir in sorted(clean_root.iterdir()):
        if not cls_dir.is_dir():
            continue
        images = sorted(p for p in cls_dir.iterdir() if p.suffix.lower() in IMAGE_EXTS)
        rng.shuffle(images)
        n    = len(images)
        n_tr = int(n * ratios[0])
        n_vl = int(n * ratios[1])
        splits = {
            "train": images[:n_tr],
            "val":   images[n_tr:n_tr + n_vl],
            "test":  images[n_tr + n_vl:],
        }
        report[cls_dir.name] = {}
        for split_name, imgs in splits.items():
            dest = split_root / split_name / cls_dir.name
            dest.mkdir(parents=True, exist_ok=True)
            for img in imgs:
                shutil.copy2(img, dest / img.name)
            report[cls_dir.name][split_name] = len(imgs)

    return report


# ── Step runners ──────────────────────────────────────────────────────────────

def run_download(workdir: Path, max_per_class: int) -> None:
    log.info("=== STEP: download (PlantVillage) ===")
    import subprocess
    cmd = [sys.executable, "-m", "ml.dataset.download_plantvillage",
           "--out", str(workdir / "raw" / "plantvillage"),
           "--max-per-class", str(max_per_class)]
    proc = subprocess.run(cmd, cwd=str(ROOT))
    if proc.returncode != 0:
        log.error("PlantVillage download failed (exit %d). Continuing with web data only.", proc.returncode)


def run_collect(workdir: Path, per_query: int, classes: list[str]) -> None:
    log.info("=== STEP: collect (web images) ===")
    import subprocess
    cmd = [sys.executable, "-m", "ml.dataset.collect_web_images",
           "--out", str(workdir / "raw" / "web"),
           "--per-query", str(per_query),
           "--classes"] + classes
    subprocess.run(cmd, cwd=str(ROOT))


def run_merge(workdir: Path) -> dict[str, int]:
    log.info("=== STEP: merge ===")
    merged_root = workdir / "merged"
    counts: dict[str, int] = {}

    for cls in AGRO_CLASSES:
        dest = merged_root / cls
        dest.mkdir(parents=True, exist_ok=True)
        n = 0
        for source_dir in [
            workdir / "raw" / "plantvillage" / cls,
            workdir / "raw" / "web" / cls,
        ]:
            if not source_dir.is_dir():
                continue
            for img in source_dir.iterdir():
                if img.suffix.lower() not in IMAGE_EXTS:
                    continue
                # Prefix with source to avoid name collisions
                prefix = "pv_" if "plantvillage" in str(source_dir) else "wb_"
                dest_f = dest / (prefix + img.name)
                if not dest_f.exists():
                    shutil.copy2(img, dest_f)
                    n += 1
        counts[cls] = n
        log.info("  %-30s %d images", cls, n)
    return counts


def run_deduplicate(workdir: Path) -> None:
    log.info("=== STEP: deduplicate ===")
    merged_root = workdir / "merged"
    for cls_dir in sorted(merged_root.iterdir()):
        if not cls_dir.is_dir():
            continue
        kept, removed = deduplicate_dir(cls_dir)
        log.info("  %-30s kept=%d  removed=%d", cls_dir.name, kept, removed)


def run_quality(workdir: Path) -> dict[str, int]:
    log.info("=== STEP: quality filter ===")
    clean_root  = workdir / "clean"
    merged_root = workdir / "merged"
    counts: dict[str, int] = {}

    for cls_dir in sorted(merged_root.iterdir()):
        if not cls_dir.is_dir():
            continue
        kept, rej = quality_filter_dir(cls_dir, clean_root / cls_dir.name)
        log.info("  %-30s kept=%d  rejected=%d", cls_dir.name, kept, rej)
        counts[cls_dir.name] = kept
    return counts


def run_split(workdir: Path) -> dict:
    log.info("=== STEP: split ===")
    report = stratified_split(workdir / "clean", workdir / "split")
    for cls, splits in sorted(report.items()):
        log.info("  %-30s train=%d  val=%d  test=%d",
                 cls, splits.get("train", 0), splits.get("val", 0), splits.get("test", 0))
    return report


def run_report(workdir: Path, split_report: dict) -> None:
    log.info("=== STEP: report ===")
    total = sum(sum(s.values()) for s in split_report.values())
    log.info("Total images in split: %d", total)

    out = {
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "total_images": total,
        "classes": split_report,
        "split_dir": str(workdir / "split"),
    }
    report_path = workdir / "dataset_report.json"
    report_path.write_text(json.dumps(out, indent=2), encoding="utf-8")
    log.info("Report → %s", report_path)
    log.info("\nReady to train:")
    log.info("  python -m ml.training.train_agronet --data %s --epochs 60", workdir / "split")


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")

    ap = argparse.ArgumentParser(description="Build full AgroNet training dataset")
    ap.add_argument("--workdir",        type=Path,  default=ROOT / "ml" / "data")
    ap.add_argument("--from-step",      choices=STEPS, default=None,
                    help="Resume from this step (skips earlier steps)")
    ap.add_argument("--only-step",      choices=STEPS, default=None)
    ap.add_argument("--max-pv-per-class", type=int, default=3000,
                    help="Cap per class from PlantVillage (0=no cap)")
    ap.add_argument("--web-per-query",  type=int,  default=80,
                    help="Images per DuckDuckGo query")
    ap.add_argument("--web-classes",    nargs="*", default=None,
                    help="Only scrape these classes from the web (default: all)")
    args = ap.parse_args()

    workdir = args.workdir
    workdir.mkdir(parents=True, exist_ok=True)

    start_idx = STEPS.index(args.from_step) if args.from_step else 0
    steps_to_run = [args.only_step] if args.only_step else STEPS[start_idx:]

    split_report: dict = {}

    for step in steps_to_run:
        if step == "download":
            run_download(workdir, args.max_pv_per_class)

        elif step == "collect":
            web_classes = args.web_classes or AGRO_CLASSES
            run_collect(workdir, args.web_per_query, web_classes)

        elif step == "merge":
            run_merge(workdir)

        elif step == "deduplicate":
            run_deduplicate(workdir)

        elif step == "quality":
            run_quality(workdir)

        elif step == "split":
            split_report = run_split(workdir)

        elif step == "report":
            if not split_report:
                # Re-derive from disk
                split_root = workdir / "split"
                for cls_dir in sorted((split_root / "train").iterdir()) if (split_root / "train").is_dir() else []:
                    if cls_dir.is_dir():
                        split_report[cls_dir.name] = {
                            s: len(list((split_root / s / cls_dir.name).iterdir()))
                            for s in ["train", "val", "test"]
                            if (split_root / s / cls_dir.name).is_dir()
                        }
            run_report(workdir, split_report)


if __name__ == "__main__":
    main()
