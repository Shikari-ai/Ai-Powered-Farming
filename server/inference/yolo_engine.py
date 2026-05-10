"""
YOLOv8 inference (Ultralytics). Loads real weights from AGRI_YOLO_WEIGHTS (.pt export).
No weights ⇒ service returns 503 — never guesses disease labels.
"""

from __future__ import annotations

import os
import threading
import time
from typing import Any

import cv2
import numpy as np

from . import reasoning


class YOLOVisionEngine:
    def __init__(self) -> None:
        self.weights = os.environ.get("AGRI_YOLO_WEIGHTS", "").strip()
        self.imgsz = int(os.environ.get("AGRI_YOLO_IMGSZ", "640"))
        self._lock = threading.Lock()
        self.model = None
        self.names: dict[int, str] = {}
        self.load_error: str | None = None

        if not self.weights:
            self.load_error = "Set AGRI_YOLO_WEIGHTS to a trained YOLOv8 .pt file."
            return

        if not os.path.isfile(self.weights):
            self.load_error = f"Weights path not found: {self.weights}"
            return

        try:
            from ultralytics import YOLO  # type: ignore

            self.model = YOLO(self.weights)
            raw = getattr(self.model, "names", None) or {}
            if isinstance(raw, dict):
                self.names = {int(k): str(v) for k, v in raw.items()}
            elif isinstance(raw, (list, tuple)):
                self.names = {i: str(n) for i, n in enumerate(raw)}
        except Exception as e:  # pragma: no cover - import / cuda env
            self.model = None
            self.load_error = f"Failed to load YOLO: {e}"

    @property
    def ok(self) -> bool:
        return self.model is not None

    def predict(
        self,
        image_bytes: bytes,
        *,
        conf_thres: float,
        iou_thres: float,
        context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if not self.ok:
            raise RuntimeError(self.load_error or "Model not loaded")

        arr = np.frombuffer(image_bytes, dtype=np.uint8)
        bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if bgr is None:
            raise ValueError("Could not decode image — unsupported or corrupt data.")

        iq = reasoning.image_quality_metrics(bgr)

        t0 = time.perf_counter()
        with self._lock:
            results = self.model.predict(  # type: ignore[union-attr]
                source=bgr,
                conf=conf_thres,
                iou=iou_thres,
                imgsz=self.imgsz,
                verbose=False,
            )
        inference_ms = round((time.perf_counter() - t0) * 1000, 2)

        r0 = results[0]
        h, w = r0.orig_shape
        detections: list[dict[str, Any]] = []

        if r0.boxes is not None and len(r0.boxes):
            for b in r0.boxes:
                xyxy = b.xyxy[0].cpu().numpy()
                x1, y1, x2, y2 = map(float, xyxy)
                cls_id = int(b.cls[0])
                conf = float(b.conf[0])
                label = self.names.get(cls_id, f"class_{cls_id}")
                why = reasoning.explain_for_label(label)
                detections.append(
                    {
                        "label": label,
                        "class_id": cls_id,
                        "confidence": round(conf, 4),
                        "box": {
                            "x1": round(x1 / w, 5),
                            "y1": round(y1 / h, 5),
                            "x2": round(x2 / w, 5),
                            "y2": round(y2 / h, 5),
                        },
                        "reasoning": why,
                    }
                )

        env_notes = reasoning.environmental_fusion_notes(detections, context)

        top = None
        top_conf = 0.0
        if detections:
            top = max(detections, key=lambda d: d["confidence"])
            top_conf = top["confidence"]

        labels = [d["label"] for d in detections]
        explanation_parts: list[str] = []
        if top:
            explanation_parts.append(
                f"Strongest ROI: **{top['label']}** at {top['confidence']*100:.1f}% model confidence (after threshold {conf_thres})."
            )
            explanation_parts.extend(f"• {b}" for b in top.get("reasoning", [])[:3])
        if iq["possibly_blurry"]:
            explanation_parts.append("Image appears soft (low Laplacian variance) — move closer or stabilise focus.")
        if iq["low_light"]:
            explanation_parts.append("Low mean luminance — retake with better light if detections are weak.")

        sev = reasoning.severity_from_confidence(top_conf, len(detections)) if detections else "none"

        return {
            "model_family": "yolov8",
            "weights_path": self.weights,
            "imgsz": self.imgsz,
            "inference_ms": inference_ms,
            "conf_threshold": conf_thres,
            "iou_threshold": iou_thres,
            "image_quality": iq,
            "detections": detections,
            "top_hypothesis": top["label"] if top else None,
            "confidence": top_conf if top else None,
            "explanation": "\n".join(explanation_parts) if explanation_parts else "No objects passed the confidence threshold.",
            "environmental_reasoning": env_notes,
            "treatments": reasoning.suggest_treatments(labels),
            "severity": sev if detections else "none",
        }
