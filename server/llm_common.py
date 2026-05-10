"""Shared grounded-system prompt for the farm assistant LLM backend."""

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

    cognitive_depth = bundle.get("reasoningDepth")
    if not isinstance(cognitive_depth, (int, float)):
        cognitive_depth = None

    depth_hint = ""
    if isinstance(cognitive_depth, (int, float)):
        if cognitive_depth >= 3:
            depth_hint = (
                "The user wants deep reasoning: connect signals, state uncertainties clearly, "
                "and separate observed facts vs inference vs prediction."
            )
        elif cognitive_depth >= 2:
            depth_hint = "Use structured, evidence-backed reasoning; several short paragraphs or bullets are OK."

    turn_kind = bundle.get("turnKind")
    turn_hint = ""
    length_style = (
        "Unless this is a pure greeting, give a complete helpful answer — not a one-line brush-off "
        "when the user clearly wants guidance."
    )
    if turn_kind == "casual":
        turn_hint = (
            "Turn type: CASUAL or greeting — warm and human; stay concise (a few sentences). "
            "No farm dossier unless they asked for detail."
        )
        length_style = "Keep this turn short and natural."
    elif turn_kind == "clarify":
        turn_hint = (
            "Turn type: CLARIFY — the user was vague about symptoms; ask 1–2 sharp follow-ups "
            "before concluding; stay supportive."
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
        "You are an expert agricultural copilot for Smart Agri — knowledgeable, practical, and conversational.",
        "Answer the user's message directly. When farm data is relevant, tie it to EVIDENCE_JSON; when it is not, "
        "still be a helpful assistant (e.g. general agronomy concepts) without inventing numbers for *their* farm.",
        length_style,
        "Rules:",
        "- Never fabricate readings, counts, or events that contradict EVIDENCE_JSON. If something is absent, say data is not available.",
        "- Match tone to the user: professional but approachable, not robotic or call-center scripted.",
        "- State uncertainty when data is stale or confidence is low (degradedMode / verification flags).",
        "- Never guarantee yields, cures, or autonomous field actions — you advise; farmers decide and execute.",
        "- Avoid alarmist language; prefer 'elevated risk' and concrete next checks.",
        f"- Preferred language/locale hint: {loc}. Reply in that language when it fits the user's message.",
        depth_hint,
        turn_hint,
        directives,
        "\nEVIDENCE_JSON:\n",
        bundle_json,
    ]
    return "\n".join(p for p in system_parts if p)
