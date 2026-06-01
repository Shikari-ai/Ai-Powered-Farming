#!/usr/bin/env python3
"""
Flatten a Roboflow YOLOv8-style export (zip) into dataset/images + dataset/labels.

Expected inside the archive (common Roboflow layouts):
  - train/images, train/labels  (and/or valid, test)
  - or a single images/ + labels/ at root

Output: --out-dir with parallel images/ and labels/ ready for validate_yolo_dataset.py
then split_yolo.py. Stems are prefixed with split name when needed to avoid collisions.
"""

from __future__ import annotations

import argparse
import shutil
import sys
import tempfile
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}
SPLIT_DIRS = ("train", "valid", "val", "test")


def _copy_pair(src_img: Path, src_txt: Path, dest_img: Path, dest_txt: Path) -> None:
    dest_img.parent.mkdir(parents=True, exist_ok=True)
    dest_txt.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_img, dest_img)
    shutil.copy2(src_txt, dest_txt)


def flatten_roboflow_tree(extracted: Path, out_images: Path, out_labels: Path) -> int:
    used_stems: set[str] = set()
    n = 0

    def unique_stem(split: str, stem: str) -> str:
        base = f"{split}__{stem}" if split else stem
        if base not in used_stems:
            used_stems.add(base)
            return base
        i = 1
        while f"{base}_{i}" in used_stems:
            i += 1
        base = f"{base}_{i}"
        used_stems.add(base)
        return base

    # Single-folder layout: images/ + labels/ at root
    root_img = extracted / "images"
    root_lbl = extracted / "labels"
    if root_img.is_dir() and root_lbl.is_dir():
        for img in root_img.iterdir():
            if img.suffix.lower() not in IMG_EXT:
                continue
            stem = unique_stem("", img.stem)
            lbl = root_lbl / f"{img.stem}.txt"
            if not lbl.is_file():
                continue
            _copy_pair(img, lbl, out_images / f"{stem}{img.suffix.lower()}", out_labels / f"{stem}.txt")
            n += 1
        return n

    for split in SPLIT_DIRS:
        sp = extracted / split
        if not sp.is_dir():
            continue
        simg = sp / "images"
        slbl = sp / "labels"
        if not simg.is_dir():
            continue
        split_key = "val" if split == "valid" else split
        for img in simg.iterdir():
            if img.suffix.lower() not in IMG_EXT:
                continue
            stem = unique_stem(split_key, img.stem)
            lbl = (slbl / f"{img.stem}.txt") if slbl.is_dir() else None
            if not lbl or not lbl.is_file():
                continue
            ext = img.suffix.lower()
            _copy_pair(img, lbl, out_images / f"{stem}{ext}", out_labels / f"{stem}.txt")
            n += 1
    return n


def main() -> None:
    ap = argparse.ArgumentParser(description="Roboflow YOLOv8 zip → flat images/ labels/")
    ap.add_argument("zip_path", type=Path)
    ap.add_argument("--out-dir", type=Path, required=True)
    args = ap.parse_args()

    if not args.zip_path.is_file():
        raise SystemExit(f"Not a file: {args.zip_path}")

    out = args.out_dir.resolve()
    imgs = out / "images"
    lbls = out / "labels"
    if imgs.is_dir() or lbls.is_dir():
        raise SystemExit(f"Refusing to write into non-empty layout — {out} already has images/ or labels/")

    with tempfile.TemporaryDirectory(prefix="roboflow_ingest_") as td:
        tmp = Path(td)
        with zipfile.ZipFile(args.zip_path, "r") as zf:
            zf.extractall(tmp)

        # Roboflow zips often contain a single top-level folder
        children = [p for p in tmp.iterdir() if p.is_dir() and not p.name.startswith("__")]
        root = tmp
        if len(children) == 1:
            c0 = children[0]
            if (
                (c0 / "train").is_dir()
                or (c0 / "valid").is_dir()
                or (c0 / "test").is_dir()
                or ((c0 / "images").is_dir() and (c0 / "labels").is_dir())
                or (c0 / "data.yaml").is_file()
            ):
                root = c0

        count = flatten_roboflow_tree(root, imgs, lbls)
        if count == 0:
            raise SystemExit(
                "No images found. Expected train/images (Roboflow) or top-level images/ + labels/."
            )

    print(f"Ingested {count} image/label pairs into {out}")


if __name__ == "__main__":
    main()
