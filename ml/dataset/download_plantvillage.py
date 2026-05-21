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


# Public HuggingFace PlantVillage mirrors to try in order
HF_CANDIDATES = [
    "Anwarkh1/Plant_disease",
    "seyong-hong/plant-disease",
    "pasquale/plant-diseases-recognition",
    "TheMrinal/Plant_diseases",
    "PedroSampaio/plant-disease-recognition",
]


def _try_load_dataset(candidates: list[str]):
    from datasets import load_dataset
    for ds_id in candidates:
        try:
            log.info("Trying HuggingFace dataset: %s", ds_id)
            ds = load_dataset(ds_id, split="train")
            log.info("Loaded %s — %d images", ds_id, len(ds))
            return ds
        except Exception as e:
            log.warning("  Failed (%s): %s", ds_id, str(e)[:120])
    return None


def download(out_root: Path, max_per_class: int, hf_dataset: str) -> None:
    try:
        from datasets import load_dataset
    except ImportError:
        log.error("Run: pip install datasets huggingface-hub")
        sys.exit(1)
    from PIL import Image

    out_root.mkdir(parents=True, exist_ok=True)

    # Try the specified dataset first, then fallbacks
    candidates = [hf_dataset] + [c for c in HF_CANDIDATES if c != hf_dataset]
    ds = _try_load_dataset(candidates)

    if ds is None:
        log.error(
            "Could not load any PlantVillage dataset from HuggingFace.\n"
            "Manual option: download from https://www.kaggle.com/datasets/emmarex/plantdisease\n"
            "then run: python -m ml.dataset.build_full_dataset --from-step collect"
        )
        return

    log.info("Dataset loaded: %d images", len(ds))

    # Infer label column name — different datasets use different keys
    for candidate_col in ["label", "labels", "disease", "class", "category"]:
        if candidate_col in ds.column_names:
            label_col = candidate_col
            break
    else:
        label_col = ds.column_names[-1]
    log.info("Using label column: '%s' (columns: %s)", label_col, ds.column_names)
    feat = ds.features.get(label_col)
    label_names = feat.names if feat is not None and hasattr(feat, "names") else []

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


def download_via_gdown(out_root: Path, max_per_class: int) -> bool:
    """Try downloading PlantVillage from Google Drive via gdown."""
    try:
        import gdown
    except ImportError:
        log.info("gdown not available — install with: pip install gdown")
        return False

    # PlantVillage color dataset (~2.3 GB zip) — public Google Drive share
    gdrive_id  = "1uaJovDaYflSZYXUB7jBdRZ3oi8nH4nqY"
    zip_path   = out_root.parent / "plantvillage_raw.zip"
    extract_to = out_root.parent / "plantvillage_zip"

    log.info("Attempting Google Drive download (PlantVillage) …")
    try:
        gdown.download(id=gdrive_id, output=str(zip_path), quiet=False)
        if zip_path.is_file() and zip_path.stat().st_size > 1_000_000:
            import zipfile
            log.info("Extracting …")
            extract_to.mkdir(parents=True, exist_ok=True)
            with zipfile.ZipFile(zip_path) as z:
                z.extractall(str(extract_to))
            # Now map extracted ImageFolder structure to our classes
            _map_imagefolder(extract_to, out_root, max_per_class)
            return True
    except Exception as e:
        log.warning("gdown download failed: %s", e)
    return False


def _map_imagefolder(src_root: Path, out_root: Path, max_per_class: int) -> None:
    """Walk an ImageFolder directory and copy images to out_root/our_class/."""
    from PIL import Image
    counts: dict[str, int] = {}
    for class_dir in sorted(src_root.rglob("*")):
        if not class_dir.is_dir():
            continue
        images = [p for p in class_dir.iterdir()
                  if p.suffix.lower() in {".jpg", ".jpeg", ".png"}]
        if not images:
            continue
        target = _map_label(class_dir.name)
        if target is None:
            continue
        dest = out_root / target
        dest.mkdir(parents=True, exist_ok=True)
        for img in images:
            if max_per_class and counts.get(target, 0) >= max_per_class:
                break
            d = dest / img.name
            if not d.exists():
                try:
                    Image.open(img).convert("RGB").save(str(d), "JPEG", quality=92)
                    counts[target] = counts.get(target, 0) + 1
                except Exception:
                    pass
    for cls, n in sorted(counts.items()):
        log.info("  %-28s %d", cls, n)


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--out",           type=Path, default=Path("ml/data/raw/plantvillage"))
    ap.add_argument("--max-per-class", type=int,  default=3000)
    ap.add_argument("--hf-dataset",    type=str,  default="ChristianOrr/plant-disease")
    ap.add_argument("--skip-hf",       action="store_true", help="Skip HuggingFace, try gdown only")
    args = ap.parse_args()

    args.out.mkdir(parents=True, exist_ok=True)

    if not args.skip_hf:
        candidates = [args.hf_dataset] + [c for c in HF_CANDIDATES if c != args.hf_dataset]
        ds = _try_load_dataset(candidates)
        if ds is not None:
            download(args.out, args.max_per_class, args.hf_dataset)
            return

    log.info("HuggingFace unavailable — trying Google Drive fallback …")
    if not download_via_gdown(args.out, args.max_per_class):
        log.warning(
            "\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
            "PlantVillage auto-download failed. Manual options:\n"
            "\n"
            "Option A — Kaggle (free account):\n"
            "  1. Sign up at kaggle.com and get your API key (~/.kaggle/kaggle.json)\n"
            "  2. pip install kaggle\n"
            "  3. kaggle datasets download -d emmarex/plantdisease -p ml/data/raw\n"
            "  4. unzip ml/data/raw/plantdisease.zip -d ml/data/raw/plantvillage_zip\n"
            "  5. python -m ml.dataset.download_plantvillage \\\n"
            "       --skip-hf  (will pick up the extracted folder via gdown path)\n"
            "\n"
            "Option B — continue with web-collected data only:\n"
            "  python -m ml.dataset.build_full_dataset --from-step merge\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
        )


if __name__ == "__main__":
    main()
