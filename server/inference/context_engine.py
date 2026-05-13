"""
Contextual agricultural intelligence: adjusts detection confidences and explains changes.

Uses YAML-backed growth stages, disease–crop hints, field memory from client context,
and coarse seasonality — never invents numeric weather beyond supplied context.
"""

from __future__ import annotations

import time
from typing import Any


def _slug(s: str | None) -> str | None:
    if not s:
        return None
    t = str(s).strip().lower().replace(" ", "_").replace("/", "_")
    aliases = {
        "corn": "maize",
        "corn_maize": "maize",
        "soy": "soybean",
    }
    return aliases.get(t, t)


def _class_category(class_meta: dict[str, Any], label: str) -> str:
    info = class_meta.get(label) or {}
    return str(info.get("category") or "").lower()


def _unlikely_stage_labels(growth_cfg: dict[str, Any], crop_slug: str | None, stage_slug: str | None) -> set[str]:
    out: set[str] = set()
    if not crop_slug or not stage_slug:
        return out
    crops = (growth_cfg or {}).get("crops") or {}
    spec = crops.get(crop_slug) or crops.get(crop_slug.replace(" ", "_"))
    if not spec:
        return out
    stages = spec.get("stages") or []
    for st in stages:
        if str(st.get("key") or "") != stage_slug:
            continue
        for x in st.get("unlikely_diseases") or []:
            out.add(str(x))
        break
    return out


def _recurrence_hit(
    label: str,
    field_memory: list[dict[str, Any]] | None,
    window_days: int,
) -> tuple[bool, int | None]:
    if not field_memory or not label:
        return False, None
    now = time.time()
    window_s = max(1, window_days) * 86400
    best_age: int | None = None
    hit = False
    for block in field_memory:
        for entry in block.get("outbreak_history") or []:
            if str(entry.get("label") or "") != label:
                continue
            at = entry.get("at")
            try:
                if isinstance(at, (int, float)):
                    ts = float(at) / (1000.0 if float(at) > 1e12 else 1.0)
                else:
                    continue
            except (TypeError, ValueError):
                continue
            age = now - ts
            if age >= 0 and age <= window_s:
                hit = True
                days_ago = int(age // 86400)
                if best_age is None or days_ago < best_age:
                    best_age = days_ago
        for rl in block.get("recent_labels") or []:
            if str(rl) == label:
                hit = True
                if best_age is None:
                    best_age = 30
                break
    return hit, best_age


def _season_multiplier(intel: dict[str, Any], context: dict[str, Any] | None, month: int) -> tuple[float, list[str]]:
    if not context:
        return 1.0, []
    profile = context.get("climate_profile") or context.get("climateProfile")
    if not profile:
        return 1.0, []
    season_cfg = (intel.get("seasonality") or {}).get(str(profile))
    if not season_cfg:
        return 1.0, []
    months = season_cfg.get("monsoon_months") or []
    try:
        m = int(month)
    except (TypeError, ValueError):
        return 1.0, []
    notes: list[str] = []
    mult = float(season_cfg.get("fungal_pressure_multiplier") or 1.0)
    if months and m in months:
        notes.append(f"Regional season profile ({profile}): month {m} in higher fungal-risk window.")
    return mult, notes


def _risk_tier(score: float) -> str:
    if score >= 76:
        return "critical"
    if score >= 56:
        return "high"
    if score >= 34:
        return "moderate"
    return "low"


def apply_contextual_intelligence(
    detections: list[dict[str, Any]],
    context: dict[str, Any] | None,
    meta: dict[str, Any],
    *,
    image_quality: dict[str, Any] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """
    Returns (detections_with_model_confidence_and_adjustments, contextual_intel dict).
    """
    intel_cfg = meta.get("context_intelligence") or {}
    growth_cfg = meta.get("growth_stages") or {}
    class_meta = meta.get("class_metadata") or {}
    rec_cfg = intel_cfg.get("recurrence") or {}
    sup_cfg = intel_cfg.get("suppression") or {}
    env_cfg = intel_cfg.get("environment") or {}
    risk_cfg = intel_cfg.get("risk") or {}

    crop_slug = _slug((context or {}).get("crop_slug") or (context or {}).get("cropSlug"))
    stage_slug = _slug(
        (context or {}).get("growth_stage") or (context or {}).get("growthStageSlug")
    ) or _slug((growth_cfg or {}).get("default_stage"))

    month = (context or {}).get("month")
    if month is None:
        month = __import__("datetime").datetime.utcnow().month
    try:
        month_i = int(month)
    except (TypeError, ValueError):
        month_i = __import__("datetime").datetime.utcnow().month

    field_memory = (context or {}).get("field_memory") or (context or {}).get("fieldMemory")
    if field_memory is not None and not isinstance(field_memory, list):
        field_memory = None

    season_mult, season_notes = _season_multiplier(intel_cfg, context, month_i)
    unlikely = _unlikely_stage_labels(growth_cfg, crop_slug, stage_slug)

    confidence_factors: list[str] = []
    suppressions: list[str] = []
    memory_snippets: list[str] = []

    if crop_slug:
        confidence_factors.append(f"Crop context: **{crop_slug}** (metadata-aware weighting).")
    if stage_slug:
        confidence_factors.append(f"Recorded growth stage: **{stage_slug}** — unlikely classes are damped.")
    for sn in season_notes:
        confidence_factors.append(sn)

    # Scan frequency / behavior (non-invasive aggregates only)
    beh = intel_cfg.get("user_behavior") or {}
    scan_n = None
    if isinstance(field_memory, list):
        for block in field_memory:
            v = block.get("scan_count_30d")
            if isinstance(v, (int, float)):
                scan_n = int(v)
                break
    if scan_n is not None and scan_n >= int(beh.get("high_scan_threshold") or 5):
        confidence_factors.append(
            "Frequent recent scouting for this field — model outputs weighted toward corroboration."
        )

    if isinstance(field_memory, list):
        for block in field_memory[:3]:
            fid = block.get("field_id") or block.get("fieldId")
            stab = block.get("stability")
            if stab is not None:
                memory_snippets.append(f"Field {fid or '?'} stability index ≈ {stab}.")

    rh = (context or {}).get("humidity_pct") or (context or {}).get("humidityPct")
    rain = (context or {}).get("rain_today_mm") or (context or {}).get("rainTodayMm")
    rh_f = float(rh) if rh is not None else None
    rain_f = float(rain) if rain is not None else None

    out_detections: list[dict[str, Any]] = []
    for d in detections:
        label = str(d.get("label") or "")
        raw_conf = float(d.get("confidence") or 0.0)
        adj = raw_conf
        penalties: list[str] = []

        d2 = dict(d)
        d2["model_confidence"] = round(raw_conf, 4)

        # Crop ↔ disease compatibility (metadata crops list)
        info = class_meta.get(label) or {}
        crops_ok = info.get("crops") or []
        if crop_slug and crops_ok and crop_slug not in [str(x) for x in crops_ok]:
            m = float(sup_cfg.get("wrong_crop_class_multiplier") or 0.42)
            adj *= m
            penalties.append(f"{label} rarely associated with {crop_slug} in reference metadata (×{m:.2f}).")
            suppressions.append(f"Cross-crop penalty: {label} vs {crop_slug}")

        if label in unlikely:
            m = float(sup_cfg.get("unlikely_stage_multiplier") or 0.48)
            adj *= m
            penalties.append(f"{label} unlikely at stage **{stage_slug}** for this crop (×{m:.2f}).")
            suppressions.append(f"Stage filter: {label} @ {stage_slug}")

        cat = _class_category(class_meta, label)
        env_boost = 1.0
        if cat in ("fungal", "bacterial") and rh_f is not None:
            thr = float(env_cfg.get("humidity_fungal_threshold") or 78)
            if rh_f >= thr:
                env_boost *= float(1.0 + min(0.12, (rh_f - thr) / 200.0))
                confidence_factors.append(
                    f"Humidity **{rh_f:.0f}%** supports moisture-driven pathogens (context boost for {label})."
                )
        if cat in ("fungal", "bacterial") and rain_f is not None:
            s_thr = float(env_cfg.get("rain_mm_strong") or 8)
            if rain_f >= s_thr:
                env_boost *= 1.08
                confidence_factors.append(f"Recent rain **{rain_f:.1f} mm** increases splash dispersal risk.")
            elif rain_f >= float(env_cfg.get("rain_mm_moderate") or 4):
                env_boost *= 1.04

        if cat in ("fungal", "bacterial"):
            adj *= env_boost * float(season_mult)

        rec_win = int(rec_cfg.get("window_days") or 42)
        rec_boost = float(rec_cfg.get("confidence_boost") or 0.05)
        rec_cap = float(rec_cfg.get("max_boosted_confidence") or 0.93)
        hit_rec, days_ago = _recurrence_hit(label, field_memory if isinstance(field_memory, list) else None, rec_win)
        if hit_rec:
            adj = min(rec_cap, adj + rec_boost)
            da = f"~{days_ago}d ago" if days_ago is not None else "recent history"
            confidence_factors.append(
                f"Similar **{label}** signal in field memory ({da}) — slight corroboration boost."
            )
            memory_snippets.append(f"Recurrence window hit for {label}.")

        if image_quality and (image_quality.get("possibly_blurry") or image_quality.get("low_light")):
            m = float(sup_cfg.get("low_image_quality_multiplier") or 0.88)
            adj *= m
            penalties.append("Image quality cues suggest softer evidence — confidence damped.")

        adj = max(0.02, min(0.995, adj))
        d2["confidence"] = round(adj, 4)
        if penalties:
            d2["context_penalties"] = penalties
        out_detections.append(d2)

    # Sort by adjusted confidence
    out_detections.sort(key=lambda x: float(x.get("confidence") or 0), reverse=True)

    top_conf = float(out_detections[0]["confidence"]) if out_detections else 0.0
    n_det = len(out_detections)

    fungal_env = 0.0
    blob = " ".join(d.get("label", "") for d in out_detections).lower()
    if rh_f is not None and rh_f >= float(env_cfg.get("humidity_fungal_threshold") or 78):
        if any(k in blob for k in ("mildew", "blight", "rust", "fungal", "spot")):
            fungal_env = min(1.0, (rh_f - 65) / 55.0)
    rec_component = 1.0 if any("Recurrence" in x for x in confidence_factors) else 0.0
    stability_penalty = 0.0
    if isinstance(field_memory, list) and field_memory:
        s0 = field_memory[0].get("stability")
        if isinstance(s0, (int, float)):
            stability_penalty = max(0.0, (85 - float(s0)) / 85.0)

    risk_score = (
        top_conf * float(risk_cfg.get("weight_model_confidence") or 38)
        + min(n_det, 8) * float(risk_cfg.get("weight_detection_count") or 6)
        + fungal_env * float(risk_cfg.get("weight_fungal_environment") or 18)
        + rec_component * float(risk_cfg.get("weight_recurrence") or 16)
        + stability_penalty * float(risk_cfg.get("weight_stability_inverse") or 12)
        + (season_mult - 1.0) * 100 * float(risk_cfg.get("weight_monsoon_profile") or 10) * 0.01
    )
    risk_score = max(0.0, min(100.0, risk_score))
    tier = _risk_tier(risk_score)

    contextual_intel = {
        "context_version": 1,
        "risk_tier": tier,
        "risk_score_0_100": round(risk_score, 1),
        "confidence_factors": confidence_factors[:12],
        "suppressions_applied": suppressions[:12],
        "field_memory_snippets": memory_snippets[:6],
        "crop_slug_resolved": crop_slug,
        "growth_stage_resolved": stage_slug,
        "month": month_i,
    }

    return out_detections, contextual_intel
