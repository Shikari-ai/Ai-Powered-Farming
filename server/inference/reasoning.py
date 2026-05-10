"""
Evidence-linked reasoning for detections (rule templates, not hallucinated “AI prose”).
Templates are keyed by coarse symptom families so new YOLO class names still map sensibly.
"""

from __future__ import annotations

import re
from typing import Any

# Normalized token → bullet points an agronomist would recognize as *possible* signs (not a diagnosis).
_REASON_LIBRARY: list[tuple[re.Pattern, list[str]]] = [
    (
        re.compile(r"rust", re.I),
        [
            "pustule-like lesions often appear on leaf surfaces in rust complexes",
            "warm days with free moisture can help urediniospore infection cycles",
        ],
    ),
    (
        re.compile(r"blight|spot|lesion", re.I),
        [
            "necrotic or chlorotic lesions with defined margins can follow fungal or bacterial infection",
            "prolonged leaf wetness from rain/humidity raises secondary spread risk",
        ],
    ),
    (
        re.compile(r"mildew|powdery|downy", re.I),
        [
            "powdery/downed growth or felting on epidermis is consistent with mildew pathogens",
            "dense humid canopies without morning dry-down favour mildew progression",
        ],
    ),
    (
        re.compile(r"fungal|mold", re.I),
        [
            "fungal signatures often include circular/bounded lesions and sporulation under moisture",
        ],
    ),
    (
        re.compile(r"deficien|chloros|yellow", re.I),
        [
            "interveinal or uniform yellowing can track nutrient mobility (e.g. older-leaf N vs Mg patterns)",
            "confirm with soil/tissue tests — imagery alone cannot prove deficiency",
        ],
    ),
    (
        re.compile(r"pest|hole|chew", re.I),
        [
            "mechanical feeding damage often shows ragged margins or hole patterns distinct from pure disease necrosis",
        ],
    ),
    (
        re.compile(r"bacterial", re.I),
        [
            "angular lesions bounded by veins and water-soaked halos are commonly associated with bacterial leaf spots",
        ],
    ),
]


def _classify_label_tokens(label: str) -> list[str]:
    bullets: list[str] = []
    seen: set[str] = set()
    for pat, pts in _REASON_LIBRARY:
        if pat.search(label):
            for p in pts:
                key = p[:48]
                if key not in seen:
                    seen.add(key)
                    bullets.append(p)
    if not bullets:
        bullets.append(
            "Bounding-box model localised a stressed/lesion ROI — validate in-field and cross-check lab history."
        )
    return bullets[:4]


def explain_for_label(label: str) -> list[str]:
    return _classify_label_tokens(label)


def image_quality_metrics(bgr) -> dict[str, Any]:
    import cv2
    import numpy as np

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean_luma = float(np.mean(gray))
    return {
        "blur_variance": round(blur_var, 2),
        "mean_luma": round(mean_luma, 2),
        "low_light": mean_luma < 42,
        "possibly_blurry": blur_var < 55.0,
    }


def environmental_fusion_notes(detections: list[dict[str, Any]], context: dict[str, Any] | None) -> list[str]:
    """Deterministic multimodal cues — never fabricates numeric ‘probability boosts’ without inputs."""
    if not context:
        return []
    notes: list[str] = []
    rh = context.get("humidity_pct")
    rain = context.get("rain_today_mm")
    labels_c = " ".join(d.get("label", "") for d in detections).lower()

    if rh is not None and rh >= 78 and any(k in labels_c for k in ("mildew", "blight", "fungal", "spot", "rust")):
        notes.append(f"Humidity {rh:.0f}% supports extended leaf wetness — aligns with many foliar pathogen cycles.")
    if rain is not None and rain >= 6 and any(k in labels_c for k in ("blight", "bacterial", "spot")):
        notes.append(f"~{rain:.1f} mm recent rain can splash bacterial or fungal inoculum between plants.")
    return notes


def suggest_treatments(labels: list[str]) -> list[str]:
    """High-level stewardship only — always defer to local extension / label law."""
    out: list[str] = []
    blob = " ".join(labels).lower()
    if any(k in blob for k in ("fung", "mildew", "rust", "blight")):
        out.append("Scout early morning: remove worst leaves, improve airflow, confirm ID before fungicide selection.")
    if "bacterial" in blob:
        out.append("Avoid overhead irrigation; copper programmes may help some crops — verify label and PHI.")
    if any(k in blob for k in ("deficien", "yellow", "chloros")):
        out.append("Pair imagery with soil/tissue testing before major fertiliser shifts.")
    if any(k in blob for k in ("pest", "hole", "chew")):
        out.append("Identify pest stage (egg/larva/adult) before treatment — thresholds beat calendar sprays.")
    if not out:
        out.append("Continue structured scouting; log GPS-tagged photos to track lesion spread.")
    return out[:5]


def severity_from_confidence(conf: float, count: int) -> str:
    if conf >= 0.82 or count >= 4:
        return "high"
    if conf >= 0.7 or count >= 2:
        return "moderate"
    return "watch"
