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

from . import context_engine, prediction_smooth, reasoning


class YOLOVisionEngine:
    def __init__(self) -> None:
        self.weights = os.environ.get("AGRI_YOLO_WEIGHTS", "").strip()
        self.imgsz = int(os.environ.get("AGRI_YOLO_IMGSZ", "640"))
        self._lock = threading.Lock()
        self.model = None
        self.names: dict[int, str] = {}
        self.load_error: str | None = None
        self._intel_meta: dict[str, Any] = {}
        try:
            from ml_metadata import load_vision_metadata

            self._intel_meta = load_vision_metadata()
        except Exception:  # pragma: no cover
            self._intel_meta = {}

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

        contextual_intel: dict[str, Any] = {}

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

        if detections and self._intel_meta:
            detections, contextual_intel = context_engine.apply_contextual_intelligence(
                detections, context, self._intel_meta, image_quality=iq
            )

        env_notes = reasoning.environmental_fusion_notes(detections, context)

        top = None
        top_conf = 0.0
        if detections:
            top = max(detections, key=lambda d: d["confidence"])
            top_conf = top["confidence"]

        raw_label = top["label"] if top else None
        raw_conf = float(top_conf) if top else None
        top_label = raw_label
        top_conf_out = raw_conf
        track_id = None
        if context:
            track_id = context.get("smooth_tracking_id") or context.get("tracking_id")
        if track_id and raw_label is not None and raw_conf is not None:
            top_label, top_conf_out = prediction_smooth.smooth_top(
                str(track_id), raw_label, raw_conf
            )

        labels = [d["label"] for d in detections]
        explanation_parts: list[str] = []
        if top and top_label is not None and top_conf_out is not None:
            ex = (
                f"Strongest ROI: **{top_label}** at {top_conf_out * 100:.1f}% model confidence "
                f"(after threshold {conf_thres})."
            )
            if raw_label and (
                top_label != raw_label
                or raw_conf is not None and abs(top_conf_out - raw_conf) > 0.02
            ):
                ex += f" This-frame peak: **{raw_label}** at {raw_conf * 100:.1f}%."
            explanation_parts.append(ex)
            explanation_parts.extend(f"• {b}" for b in top.get("reasoning", [])[:3])
        if iq["possibly_blurry"]:
            explanation_parts.append("Image appears soft (low Laplacian variance) — move closer or stabilise focus.")
        if iq["low_light"]:
            explanation_parts.append("Low mean luminance — retake with better light if detections are weak.")
        for cf in contextual_intel.get("confidence_factors", [])[:6]:
            explanation_parts.append(f"Context reasoning: {cf}")
        if contextual_intel.get("suppressions_applied"):
            explanation_parts.append(
                "Some classes were context-damped (crop stage, crop–disease fit, or image quality)."
            )

        sev = (
            reasoning.severity_from_confidence(top_conf_out or 0.0, len(detections))
            if detections
            else "none"
        )

        return {
            "model_family": "yolov8",
            "weights_path": self.weights,
            "imgsz": self.imgsz,
            "inference_ms": inference_ms,
            "conf_threshold": conf_thres,
            "iou_threshold": iou_thres,
            "image_quality": iq,
            "detections": detections,
            "top_hypothesis": top_label,
            "confidence": top_conf_out,
            "explanation": "\n".join(explanation_parts) if explanation_parts else "No objects passed the confidence threshold.",
            "environmental_reasoning": env_notes,
            "treatments": reasoning.suggest_treatments(labels),
            "severity": sev if detections else "none",
            "contextual_intel": contextual_intel if contextual_intel else None,
            "prediction_reliability": {
                "risk_tier": contextual_intel.get("risk_tier") if contextual_intel else None,
                "risk_score_0_100": contextual_intel.get("risk_score_0_100") if contextual_intel else None,
                "field_memory_used": bool(context and (context.get("field_memory") or context.get("fieldMemory"))),
            },
        }
