#!/usr/bin/env python3
"""Export best.pt → ONNX (and optional int8) for mobile / web runtimes."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ultralytics import YOLO

from ml.lib import load_vision_metadata


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("weights", type=Path, help="best.pt")
    ap.add_argument("--imgsz", type=int, default=640)
    ap.add_argument("--out-dir", type=Path, default=None)
    ap.add_argument(
        "--tflite",
        action="store_true",
        help="Also export TFLite if the installed Ultralytics build supports it.",
    )
    args = ap.parse_args()

    meta = load_vision_metadata()
    out = args.out_dir or args.weights.parent
    out.mkdir(parents=True, exist_ok=True)

    model = YOLO(str(args.weights))
    onnx_path = model.export(format="onnx", imgsz=args.imgsz, simplify=True, opset=12)

    registry = {
        "source_weights": str(args.weights.resolve()),
        "onnx": str(Path(onnx_path).resolve()),
        "nc": meta["nc"],
        "names": meta["names"],
        "imgsz": args.imgsz,
        "note": "Quantized TFLite for edge: pass --tflite or convert ONNX in CI as needed.",
    }
    if args.tflite:
        try:
            m2 = YOLO(str(args.weights.resolve()))
            tflite_path = m2.export(format="tflite", imgsz=args.imgsz)
            registry["tflite"] = str(Path(tflite_path).resolve())
        except Exception as e:  # pragma: no cover
            registry["tflite_error"] = str(e)
    (out / "export_registry.json").write_text(json.dumps(registry, indent=2), encoding="utf-8")
    print(json.dumps(registry, indent=2))


if __name__ == "__main__":
    main()
