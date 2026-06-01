#!/usr/bin/env python3
"""Validate YOLO-label dataset, filter low-quality images, report duplicates."""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import yaml

from ml.dataset.quality import assess_image
from ml.lib import load_vision_metadata

try:
    import imagehash
    from PIL import Image

    HAS_PHASH = True
except ImportError:
    HAS_PHASH = False

IMG_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp"}


def parse_yolo_labels(txt: Path, nc: int) -> tuple[list[int], list[str]]:
    errs: list[str] = []
    classes: list[int] = []
    if not txt.is_file():
        return classes, ["missing_label_file"]
    for line_no, line in enumerate(txt.read_text(encoding="utf-8", errors="ignore").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        if len(parts) != 5:
            errs.append(f"line_{line_no}_not_5_fields")
            continue
        try:
            ci = int(parts[0])
        except ValueError:
            errs.append(f"line_{line_no}_bad_class")
            continue
        if ci < 0 or ci >= nc:
            errs.append(f"line_{line_no}_class_out_of_range_{ci}")
            continue
        ok_coords = True
        for x in parts[1:]:
            try:
                v = float(x)
            except ValueError:
                ok_coords = False
                break
            if v < 0 or v > 1:
                ok_coords = False
                break
        if not ok_coords:
            errs.append(f"line_{line_no}_bad_coord")
            continue
        classes.append(ci)
    return classes, errs


def main() -> None:
    ap = argparse.ArgumentParser(description="Validate YOLO dataset directory (images/ + labels/).")
    ap.add_argument("dataset", type=Path, help="Folder containing images/ and labels/")
    ap.add_argument("--out-report", type=Path, default=Path("ml/runs/validate_report.json"))
    ap.add_argument("--quarantine", type=Path, default=None, help="Copy rejected pairs here")
    ap.add_argument("--policy", type=Path, default=None, help="Override dataset_policy.yaml")
    args = ap.parse_args()

    meta = load_vision_metadata()
    nc = int(meta["nc"])
    names = meta["names"]
    policy_path = args.policy or (ROOT / "ml" / "config" / "dataset_policy.yaml")
    with policy_path.open("r", encoding="utf-8") as f:
        policy = yaml.safe_load(f) or {}
    qconf = policy.get("quality", {})

    img_dir = args.dataset / "images"
    lbl_dir = args.dataset / "labels"
    if not img_dir.is_dir() or not lbl_dir.is_dir():
        raise SystemExit("Expected dataset/images and dataset/labels")

    report: dict = {
        "nc": nc,
        "names": names,
        "counts": {"accepted": 0, "rejected": 0},
        "rejections": [],
        "class_histogram": Counter(),
        "duplicates_sha256": [],
        "duplicates_phash": [],
    }

    if args.quarantine:
        args.quarantine.mkdir(parents=True, exist_ok=True)

    byte_hashes: dict[str, list[str]] = defaultdict(list)
    phash_map: dict[str, list[str]] = defaultdict(list)

    for img_path in sorted(img_dir.iterdir()):
        if img_path.suffix.lower() not in IMG_EXT:
            continue
        stem = img_path.stem
        lbl_path = lbl_dir / f"{stem}.txt"
        cls_list, yolo_errs = parse_yolo_labels(lbl_path, nc)

        reasons = list(yolo_errs)
        if qconf.get("reject_if_no_label", True) and not cls_list and not yolo_errs:
            reasons.append("empty_label_no_objects")

        qr = assess_image(
            img_path,
            min_edge=int(qconf.get("min_edge_px", 320)),
            max_edge=int(qconf.get("max_edge_px", 4096)),
            min_blur_var=float(qconf.get("min_blur_variance", 45)),
            max_underexposed=float(qconf.get("max_mean_luma_underexposed", 38)),
            min_overexposed=float(qconf.get("min_mean_luma_overexposed", 230)),
        )
        if not qr.ok:
            reasons.extend(qr.reasons)

        digest = hashlib.sha256(img_path.read_bytes()).hexdigest()
        byte_hashes[digest].append(str(img_path))

        if HAS_PHASH and not reasons:
            try:
                ph = str(imagehash.phash(Image.open(img_path).convert("RGB")))
                phash_map[ph].append(str(img_path))
            except Exception:
                reasons.append("phash_fail")

        if reasons:
            report["counts"]["rejected"] += 1
            report["rejections"].append({"image": str(img_path), "reasons": reasons})
            if args.quarantine:
                shutil.copy2(img_path, args.quarantine / img_path.name)
                if lbl_path.is_file():
                    shutil.copy2(lbl_path, args.quarantine / f"{stem}.txt")
            continue

        report["counts"]["accepted"] += 1
        for c in cls_list:
            report["class_histogram"][names[c] if c < len(names) else str(c)] += 1

    for d, paths in byte_hashes.items():
        if len(paths) > 1:
            report["duplicates_sha256"].append({"hash": d[:24], "paths": paths})

    if HAS_PHASH:
        for ph, paths in phash_map.items():
            if len(paths) > 1:
                report["duplicates_phash"].append({"phash": ph, "paths": paths})

    args.out_report.parent.mkdir(parents=True, exist_ok=True)
    report["class_histogram"] = dict(report["class_histogram"])
    args.out_report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report["counts"], indent=2))
    print("Wrote", args.out_report)


if __name__ == "__main__":
    main()
