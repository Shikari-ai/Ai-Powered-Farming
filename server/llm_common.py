"""Shared grounded-system prompt for farm assistant (Gemini + GitHub Models)."""

from __future__ import annotations

import json
from typing import Any


def truncate_json(obj: Any, max_chars: int = 120_000) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        s = str(obj)
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 80] + "\n…[truncated for model context]…"


def build_grounded_system_prompt(*, locale: str, evidence_bundle: dict[str, Any]) -> str:
    loc = (locale or "en").strip() or "en"
    bundle = evidence_bundle if isinstance(evidence_bundle, dict) else {}
    bundle_json = truncate_json(bundle)

    cognitive_depth = bundle.get("reasoningDepth") if isinstance(bundle.get("reasoningDepth"), (int, float)) else None
    depth_hint = ""
    if isinstance(cognitive_depth, (int, float)):
        if cognitive_depth >= 3:
            depth_hint = (
                "The client requested deep reasoning: connect signals, state uncertainties, "
                "separate observed vs predicted."
            )
        elif cognitive_depth >= 2:
            depth_hint = "Use clear, structured reasoning; moderate length."

    turn_kind = bundle.get("turnKind")
    turn_hint = ""
    if turn_kind == "casual":
        turn_hint = (
            "Turn type: CASUAL or greeting — keep it short, warm, human; "
            "no farm brief unless the user asked."
        )
    elif turn_kind == "clarify":
        turn_hint = (
            "Turn type: CLARIFY — user was vague about symptoms; "
            "prefer 1–2 sharp questions over conclusions."
        )

    directives = ""
    companion = bundle.get("companion")
    if isinstance(companion, dict):
        d = companion.get("directives")
        if isinstance(d, str) and d.strip():
            directives = (
                "\n\nPERSONALIZATION (from stored profile; do not contradict evidence):\n"
                f"{d.strip()[:8000]}\n"
            )

    system_parts = [
        "You are the agricultural copilot for Smart Agri. You must ground every claim in EVIDENCE_JSON below.",
        "Rules:",
        "- Only cite or imply facts that appear in EVIDENCE_JSON. If something is absent, say data is not available.",
        "- Prefer short paragraphs; no markdown tables unless the user explicitly asks.",
        "- State uncertainty when confidence is low or data is stale (see degradedMode / verification flags).",
        "- Never guarantee yields, disease outcomes, or autonomous field actions. Humans execute all field work.",
        "- Avoid alarmist language; prefer 'elevated risk' and early verification.",
        f"- Preferred locale for this turn: {loc}. Use it when natural.",
        depth_hint,
        turn_hint,
        directives,
        "\nEVIDENCE_JSON:\n",
        bundle_json,
    ]
    return "\n".join(p for p in system_parts if p)
