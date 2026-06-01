#!/usr/bin/env python3
"""Offline augmentation for YOLO train split (writes parallel images + updated labels)."""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import cv2
import numpy as np
import yaml
from albumentations import (
    Compose,
    GaussNoise,
    HorizontalFlip,
    HueSaturationValue,
    RandomBrightnessContrast,
    Rotate,
)

from ml.lib import load_vision_metadata

IMG_EXT = {".jpg", ".jpeg", ".png"}


def yolo_to_pixels(line: str, w: int, h: int) -> tuple[int, int, int, int, int] | None:
    p = line.split()
    if len(p) != 5:
        return None
    cls = int(p[0])
    cx, cy, bw, bh = map(float, p[1:])
    px = int((cx - bw / 2) * w)
    py = int((cy - bh / 2) * h)
    pw = int(bw * w)
    ph = int(bh * h)
    return cls, px, py, pw, ph


def pixels_to_yolo(cls: int, x1: float, y1: float, x2: float, y2: float, w: int, h: int) -> str:
    bw = max((x2 - x1) / w, 1e-6)
    bh = max((y2 - y1) / h, 1e-6)
    cx = (x1 + x2) / 2 / w
    cy = (y1 + y2) / 2 / h
    return f"{cls} {cx:.6f} {cy:.6f} {bw:.6f} {bh:.6f}\n"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("dataset", type=Path, help="Split dataset root")
    ap.add_argument("--max-per-source", type=int, default=2)
    ap.add_argument("--policy", type=Path, default=None)
    args = ap.parse_args()

    policy_path = args.policy or (ROOT / "ml" / "config" / "dataset_policy.yaml")
    with policy_path.open("r", encoding="utf-8") as f:
        aug = (yaml.safe_load(f) or {}).get("augmentation", {})

    meta = load_vision_metadata()
    _ = meta

    aug_pipe = Compose(
        [
            HorizontalFlip(p=float(aug.get("horizontal_flip_p", 0.5))),
            Rotate(limit=int(aug.get("rotate_limit_deg", 12)), p=0.35, border_mode=cv2.BORDER_REFLECT),
            RandomBrightnessContrast(
                brightness_limit=float(aug.get("brightness_limit", 0.18)),
                contrast_limit=float(aug.get("contrast_limit", 0.18)),
                p=0.45,
            ),
            HueSaturationValue(
                hue_shift_limit=int(aug.get("hue_shift_limit", 6)),
                sat_shift_limit=int(aug.get("sat_shift_limit", 18)),
                val_shift_limit=int(aug.get("val_shift_limit", 18)),
                p=0.35,
            ),
            GaussNoise(var_limit=(0, float(aug.get("gauss_noise_var_limit", 8))), p=0.2),
        ],
        bbox_params={"format": "pascal_voc", "label_fields": ["cls_ids"]},
    )

    img_dir = args.dataset / "images" / "train"
    lbl_dir = args.dataset / "labels" / "train"
    out_img = args.dataset / "images" / "train_aug"
    out_lbl = args.dataset / "labels" / "train_aug"
    out_img.mkdir(parents=True, exist_ok=True)
    out_lbl.mkdir(parents=True, exist_ok=True)

    rnd = random.Random(42)
    for img_path in sorted(img_dir.iterdir()):
        if img_path.suffix.lower() not in IMG_EXT:
            continue
        stem = img_path.stem
        lbl_path = lbl_dir / f"{stem}.txt"
        if not lbl_path.is_file():
            continue
        bgr = cv2.imread(str(img_path))
        if bgr is None:
            continue
        h, w = bgr.shape[:2]
        lines_in = [ln for ln in lbl_path.read_text(encoding="utf-8").splitlines() if ln.strip()]
        boxes = []
        cls_ids = []
        for ln in lines_in:
            parsed = yolo_to_pixels(ln, w, h)
            if not parsed:
                continue
            cls, px, py, pw, ph = parsed
            boxes.append([px, py, px + pw, py + ph])
            cls_ids.append(cls)
        if not boxes:
            continue

        for k in range(min(args.max_per_source, int(aug.get("max_augmented_copies_per_image", 2)))):
            rnd.seed(hash(stem) + k)
            data = aug_pipe(image=bgr, bboxes=boxes, cls_ids=cls_ids)
            im2 = data["image"]
            b2 = data["bboxes"]
            c2 = data["cls_ids"]
            h2, w2 = im2.shape[:2]
            out_lines = []
            for bb, cc in zip(b2, c2):
                x1, y1, x2, y2 = bb
                x1 = max(0, min(x1, w2 - 1))
                x2 = max(0, min(x2, w2 - 1))
                y1 = max(0, min(y1, h2 - 1))
                y2 = max(0, min(y2, h2 - 1))
                if x2 - x1 < 4 or y2 - y1 < 4:
                    continue
                out_lines.append(pixels_to_yolo(int(cc), x1, y1, x2, y2, w2, h2))
            if not out_lines:
                continue
            name = f"{stem}_aug{k}.jpg"
            cv2.imwrite(str(out_img / name), im2)
            (out_lbl / f"{stem}_aug{k}.txt").write_text("".join(out_lines), encoding="utf-8")

    print("Augmented copies →", out_img, "(merge into train or update data.yaml paths manually)")


if __name__ == "__main__":
    main()
