"""Image quality metrics for training curation (OpenCV)."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np


@dataclass
class QualityResult:
    ok: bool
    blur_variance: float
    mean_luma: float
    h: int
    w: int
    reasons: list[str]


def assess_image(
    path: Path,
    *,
    min_edge: int = 320,
    max_edge: int = 4096,
    min_blur_var: float = 45.0,
    max_underexposed: float = 38.0,
    min_overexposed: float = 230.0,
) -> QualityResult:
    reasons: list[str] = []
    bgr = cv2.imread(str(path))
    if bgr is None:
        return QualityResult(False, 0.0, 0.0, 0, 0, ["unreadable_or_corrupt"])

    h, w = bgr.shape[:2]
    if min(h, w) < min_edge:
        reasons.append(f"min_edge_lt_{min_edge}")
    if max(h, w) > max_edge:
        reasons.append(f"max_edge_gt_{max_edge}")

    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    blur_var = float(cv2.Laplacian(gray, cv2.CV_64F).var())
    mean_luma = float(np.mean(gray))

    if blur_var < min_blur_var:
        reasons.append("blurry_low_laplacian")
    if mean_luma < max_underexposed:
        reasons.append("underexposed")
    if mean_luma > min_overexposed:
        reasons.append("overexposed")

    ok = len(reasons) == 0
    return QualityResult(ok, blur_var, mean_luma, h, w, reasons)
