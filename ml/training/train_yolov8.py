#!/usr/bin/env python3
"""Reproducible YOLOv8 training with metadata-linked classes and metrics export."""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import yaml
from ultralytics import YOLO

from ml.lib import load_vision_metadata


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, required=True, help="Ultralytics data.yaml")
    ap.add_argument("--exp-name", type=str, default=None)
    ap.add_argument("--train-config", type=Path, default=ROOT / "ml" / "config" / "train_defaults.yaml")
    args = ap.parse_args()

    meta = load_vision_metadata()
    with args.train_config.open("r", encoding="utf-8") as f:
        tc = yaml.safe_load(f) or {}

    exp = args.exp_name or f"exp_{int(time.time())}"
    project = ROOT / "ml" / "runs" / "detect"
    project.mkdir(parents=True, exist_ok=True)

    weights = tc.get("model", "yolov8n.pt")
    model = YOLO(weights)

    train_kw = dict(
        data=str(args.data.resolve()),
        epochs=int(tc.get("epochs", 120)),
        imgsz=int(tc.get("imgsz", 640)),
        batch=int(tc.get("batch", 16)),
        patience=int(tc.get("patience", 35)),
        optimizer=str(tc.get("optimizer", "AdamW")),
        lr0=float(tc.get("lr0", 0.01)),
        lrf=float(tc.get("lrf", 0.01)),
        warmup_epochs=int(tc.get("warmup_epochs", 3)),
        cos_lr=bool(tc.get("cos_lr", True)),
        close_mosaic=int(tc.get("close_mosaic", 15)),
        workers=int(tc.get("workers", 8)),
        project=str(project),
        name=exp,
        exist_ok=True,
    )
    dev = tc.get("device") or ""
    if dev:
        train_kw["device"] = dev

    model.train(**train_kw)
    trainer = getattr(model, "trainer", None)
    save_dir = Path(trainer.save_dir) if trainer and getattr(trainer, "save_dir", None) else (project / exp)
    best = save_dir / "weights" / "best.pt"
    metrics_path = save_dir / "metrics_summary.json"
    summary = {
        "exp_name": exp,
        "save_dir": str(save_dir),
        "best_weights": str(best) if best.is_file() else None,
        "classes": {"nc": meta["nc"], "names": meta["names"]},
        "train_config": tc,
        "results_csv": str(save_dir / "results.csv"),
    }
    for cm_name in ("confusion_matrix_normalized.png", "confusion_matrix.png"):
        cm_p = save_dir / cm_name
        if cm_p.is_file():
            summary["confusion_matrix_png"] = str(cm_p.resolve())
            break
    if best.is_file():
        val = model.val(data=str(args.data.resolve()), split="val")
        box = getattr(val, "box", None)
        summary["val_metrics"] = {
            "map50": float(box.map50) if box is not None and getattr(box, "map50", None) is not None else None,
            "map50_95": float(box.map) if box is not None and getattr(box, "map", None) is not None else None,
        }
    metrics_path.write_text(json.dumps(summary, indent=2), encoding="utf-8")
    print("Saved", metrics_path, "best:", summary.get("best_weights"))


if __name__ == "__main__":
    main()
