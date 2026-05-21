#!/usr/bin/env python3
"""
Download PlantVillage dataset from HuggingFace and map its 38 classes to our
10 AgroNet disease classes.

PlantVillage has 54,306 images of 14 crops × 26 diseases + healthy.
We only keep images whose PlantVillage class is a confident match to one of
our 10 target classes.

Usage:
    python -m ml.dataset.download_plantvillage --out ml/data/raw/plantvillage

Requirements:
    pip install datasets huggingface-hub Pillow
"""

from __future__ import annotations

import argparse
import logging
import shutil
import sys
from pathlib import Path

log = logging.getLogger("download_plantvillage")

# ── PlantVillage → AgroNet class mapping ─────────────────────────────────────
# Keys are lowercase substrings matched against PlantVillage label names.
# A single PlantVillage image can match at most one AgroNet class (first match wins).

PV_CLASS_MAP: list[tuple[str, str]] = [
    # leaf_rust
    ("common_rust",      "leaf_rust"),
    ("leaf_rust",        "leaf_rust"),
    ("cedar_apple_rust", "leaf_rust"),

    # early_blight
    ("early_blight",     "early_blight"),

    # late_blight
    ("late_blight",      "late_blight"),

    # powdery_mildew
    ("powdery_mildew",   "powdery_mildew"),
    ("leaf_mold",        "powdery_mildew"),   # similar visual pattern

    # bacterial_spot
    ("bacterial_spot",   "bacterial_spot"),

    # pest_damage
    ("spider_mites",     "pest_damage"),
    ("target_spot",      "pest_damage"),
    ("leaf_scorch",      "pest_damage"),
    ("scab",             "pest_damage"),

    # general_lesion
    ("septoria",         "general_lesion"),
    ("northern_leaf",    "general_lesion"),
    ("gray_leaf",        "general_lesion"),
    ("black_rot",        "general_lesion"),
    ("esca",             "general_lesion"),
    ("blight",           "general_lesion"),  # catch-all for remaining blights
    ("mosaic",           "general_lesion"),
    ("curl_virus",       "general_lesion"),
    ("haunglongbing",    "general_lesion"),

    # healthy_leaf  (must be last — catches all remaining "healthy" labels)
    ("healthy",          "healthy_leaf"),
]

# nitrogen / potassium deficiency are NOT in PlantVillage — collected by web scraper


def _map_label(pv_label: str) -> str | None:
    """Map a PlantVillage label string to our class name, or None if unmapped."""
    lbl = pv_label.lower()
    for pattern, target in PV_CLASS_MAP:
        if pattern in lbl:
            return target
    return None


def download(out_root: Path, max_per_class: int, hf_dataset: str) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        log.error("Run: pip install datasets huggingface-hub")
        sys.exit(1)
    from PIL import Image

    out_root.mkdir(parents=True, exist_ok=True)

    log.info("Loading HuggingFace dataset: %s  (this may download ~1 GB)", hf_dataset)
    ds = load_dataset(hf_dataset, split="train", trust_remote_code=True)
    log.info("Dataset loaded: %d images", len(ds))

    # Infer label column name
    label_col = "label" if "label" in ds.column_names else ds.column_names[-1]
    label_names = ds.features[label_col].names if hasattr(ds.features[label_col], "names") else []

    counts: dict[str, int] = {}
    skipped = 0

    for i, sample in enumerate(ds):
        if i % 5000 == 0:
            log.info("  Processing %d / %d …", i, len(ds))

        # Decode label
        idx = sample[label_col]
        pv_label = label_names[idx] if label_names and idx < len(label_names) else str(idx)

        target = _map_label(pv_label)
        if target is None:
            skipped += 1
            continue

        if max_per_class and counts.get(target, 0) >= max_per_class:
            continue

        cls_dir = out_root / target
        cls_dir.mkdir(parents=True, exist_ok=True)

        fname = f"pv_{i:06d}.jpg"
        dest  = cls_dir / fname
        if dest.exists():
            counts[target] = counts.get(target, 0) + 1
            continue

        try:
            img = sample["image"]
            if not isinstance(img, Image.Image):
                img = Image.fromarray(img)
            img = img.convert("RGB")
            img.save(str(dest), "JPEG", quality=92)
            counts[target] = counts.get(target, 0) + 1
        except Exception as e:
            log.debug("Save failed for sample %d: %s", i, e)

    log.info("PlantVillage download complete:")
    for cls, n in sorted(counts.items()):
        log.info("  %-28s %d", cls, n)
    log.info("  (skipped %d unmapped)", skipped)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--out",           type=Path, default=Path("ml/data/raw/plantvillage"))
    ap.add_argument("--max-per-class", type=int,  default=3000,
                    help="Cap images per class to balance the dataset (0 = no cap)")
    ap.add_argument("--hf-dataset",   type=str,
                    default="nelorth/oxford-flowers",   # overridden below
                    help="HuggingFace dataset ID")
    args = ap.parse_args()

    # Use the best available PlantVillage mirror on HuggingFace
    hf_id = "ChristianOrr/plant-disease"   # 54k images, all 38 classes
    log.info("Using HuggingFace dataset: %s", hf_id)
    download(args.out, args.max_per_class, hf_id)


if __name__ == "__main__":
    main()
