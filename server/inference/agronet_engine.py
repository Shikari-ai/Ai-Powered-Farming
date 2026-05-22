"""
AgroNet inference engine — wraps the custom AgroNet model + disease KB lookup.

Produces a rich scan response:
  - disease label + confidence
  - health score (0-100)
  - full disease info from KB (description, symptoms, severity)
  - pesticide recommendations with dosages and PHI
  - organic alternatives
  - prevention tips

Set AGRI_AGRONET_WEIGHTS to a trained agronet_best.pth to activate.
Without weights the engine reports ok=False and callers fall back to YOLO.
"""

from __future__ import annotations

import io
import logging
import os
import time
from pathlib import Path
from typing import Any, Optional

import yaml

log = logging.getLogger(__name__)

ROOT = Path(__file__).resolve().parents[2]  # server/inference/ → server/ → project root
KB_PATH = ROOT / "ml" / "config" / "disease_kb.yaml"

# ── Knowledge Base loader (singleton) ────────────────────────────────────────

_KB: dict | None = None


def _load_kb() -> dict:
    global _KB
    if _KB is not None:
        return _KB
    if not KB_PATH.is_file():
        log.warning("disease_kb.yaml not found at %s", KB_PATH)
        _KB = {}
        return _KB
    _KB = yaml.safe_load(KB_PATH.read_text(encoding="utf-8")).get("classes", {})
    log.info("Loaded disease KB: %d entries", len(_KB))
    return _KB


# ── Transform (must match train_agronet.py val_transform) ────────────────────

def _preprocess(image_bytes: bytes):
    import cv2
    import numpy as np
    import torch
    from torchvision import transforms

    buf = np.frombuffer(image_bytes, dtype=np.uint8)
    img_bgr = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img_bgr is None:
        raise ValueError("Could not decode image")
    img_rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)

    tfm = transforms.Compose([
        transforms.ToPILImage(),
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize([0.485, 0.456, 0.406], [0.229, 0.224, 0.225]),
    ])
    return tfm(img_rgb).unsqueeze(0)  # (1, 3, 224, 224)


# ── KB enrichment ─────────────────────────────────────────────────────────────

def _severity_label(confidence: float, health_score: float) -> str:
    if health_score >= 85:
        return "none"
    if confidence >= 0.85 or health_score < 25:
        return "high"
    if confidence >= 0.65 or health_score < 50:
        return "moderate"
    return "watch"


def _enrich_with_kb(label: str, confidence: float, health_score: float) -> dict:
    kb = _load_kb()
    entry = kb.get(label, {})
    if not entry:
        return {"label": label, "confidence": confidence, "health_score": health_score}

    severity = _severity_label(confidence, health_score)

    result: dict[str, Any] = {
        "label":        label,
        "display_name": entry.get("display_name", label),
        "confidence":   round(confidence, 4),
        "health_score": round(health_score, 1),
        "severity":     severity,
        "category":     entry.get("category", "unknown"),
        "spread_risk":  entry.get("spread_risk", "unknown"),
        "description":  entry.get("description", "").strip(),
        "symptoms":     entry.get("symptoms", []),
        "affected_crops": entry.get("affected_crops", []),
    }

    # Severity indicator text
    sev_map = entry.get("severity_indicators", {})
    sev_key = {"high": "severe", "moderate": "moderate", "watch": "mild", "none": None}.get(severity)
    if sev_key and sev_map.get(sev_key):
        result["severity_description"] = sev_map[sev_key]

    # Treatments — include all tiers but flag urgency
    tx = entry.get("treatments", {})
    result["treatments"] = {
        "chemical":   tx.get("chemical", []),
        "organic":    tx.get("organic", []),
        "preventive": tx.get("preventive", []),
    }

    # Flatten top pesticide recommendation for quick access
    chemical_list = tx.get("chemical", [])
    if chemical_list and label != "healthy_leaf":
        top = chemical_list[0]
        result["primary_pesticide"] = {
            "name":    top.get("name"),
            "dosage":  top.get("dosage"),
            "phi_days": top.get("phi_days"),
            "safety":  top.get("safety"),
        }

    if entry.get("notes"):
        result["notes"] = entry["notes"]

    return result


# ── Engine class ─────────────────────────────────────────────────────────────

class AgroNetEngine:
    def __init__(self) -> None:
        self.ok         = False
        self.weights    = ""
        self.load_error: Optional[str] = None
        self._model     = None
        self._device    = "cpu"
        self._load()

    def _load(self) -> None:
        weights = os.environ.get("AGRI_AGRONET_WEIGHTS", "").strip()
        if not weights:
            self.load_error = "AGRI_AGRONET_WEIGHTS not set — AgroNet engine inactive"
            log.info(self.load_error)
            return
        p = Path(weights)
        if not p.is_absolute():
            p = ROOT / p          # resolve relative to project root
        if not p.is_file():
            self.load_error = f"AgroNet weights not found: {p}"
            log.warning(self.load_error)
            return
        try:
            import torch
            from ml.models.agro_net import AgroNet
            dev = os.environ.get("AGRI_DEVICE", "cpu")
            if dev == "cuda" and not torch.cuda.is_available():
                dev = "cpu"
            self._model  = AgroNet.load(str(p), device=dev)
            self._device = dev
            self.weights = str(p)
            self.ok      = True
            log.info("AgroNet loaded: %s  device=%s", p.name, dev)
        except Exception as e:
            self.load_error = f"AgroNet load failed: {e}"
            log.error(self.load_error)

    def scan(self, image_bytes: bytes) -> dict[str, Any]:
        """
        Run AgroNet on raw image bytes.
        Returns enriched response with disease info + pesticides + health score.
        Raises RuntimeError if engine not ready.
        """
        if not self.ok or self._model is None:
            raise RuntimeError(self.load_error or "AgroNet engine not ready")

        import torch

        t0 = time.perf_counter()
        try:
            tensor = _preprocess(image_bytes).to(self._device)
        except ValueError as e:
            raise ValueError(str(e)) from e

        with torch.no_grad():
            result = self._model.predict(tensor)

        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)

        label       = result["label"]
        confidence  = result["confidence"]
        health_score = result["health_score"]
        all_probs   = result["all_probs"]

        enriched = _enrich_with_kb(label, confidence, health_score)

        # Top-3 alternatives
        sorted_probs = sorted(all_probs.items(), key=lambda x: x[1], reverse=True)
        alternatives = [
            {"label": lbl, "confidence": round(conf, 4)}
            for lbl, conf in sorted_probs[1:4]
        ]

        return {
            "engine":        "agronet",
            "model_version": Path(self.weights).name,
            "inference_ms":  elapsed_ms,
            "label":         enriched.get("label"),
            "display_name":  enriched.get("display_name"),
            "confidence":    enriched.get("confidence"),
            "health_score":  enriched.get("health_score"),
            "severity":      enriched.get("severity"),
            "category":      enriched.get("category"),
            "spread_risk":   enriched.get("spread_risk"),
            "description":   enriched.get("description"),
            "symptoms":      enriched.get("symptoms"),
            "severity_description": enriched.get("severity_description"),
            "affected_crops":  enriched.get("affected_crops"),
            "treatments":    enriched.get("treatments"),
            "primary_pesticide": enriched.get("primary_pesticide"),
            "notes":         enriched.get("notes"),
            "alternatives":  alternatives,
        }
