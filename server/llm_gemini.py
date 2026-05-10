"""
Grounded farm assistant via Google Gemini (default: gemini-2.5-flash).

Requires GEMINI_API_KEY. Optional GEMINI_MODEL (e.g. gemini-2.5-flash).
Never log the API key.
"""

from __future__ import annotations

import json
import os
from typing import Any

# Lazy import so `import main` still works in environments without google-generativeai
_genai = None


def _ensure_genai():
    global _genai
    if _genai is None:
        try:
            import google.generativeai as genai

            _genai = genai
        except ImportError as e:
            raise RuntimeError(
                "google-generativeai is not installed. pip install google-generativeai"
            ) from e
    return _genai


def _truncate_json(obj: Any, max_chars: int = 120_000) -> str:
    try:
        s = json.dumps(obj, ensure_ascii=False, default=str)
    except (TypeError, ValueError):
        s = str(obj)
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 80] + "\n…[truncated for model context]…"


def grounded_farm_reply(
    *,
    question: str,
    locale: str,
    evidence_bundle: dict[str, Any],
) -> dict[str, Any]:
    api_key = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    if not api_key:
        raise ValueError("Set GEMINI_API_KEY (or GOOGLE_API_KEY) on the server for grounded chat.")

    model_id = (
        os.environ.get("GEMINI_MODEL", "gemini-2.5-flash").strip() or "gemini-2.5-flash"
    )
    genai = _ensure_genai()
    genai.configure(api_key=api_key)

    q = (question or "").strip() or "Summarize the farm evidence briefly."
    loc = (locale or "en").strip() or "en"

    bundle_json = _truncate_json(evidence_bundle or {})
    cognitive_depth = evidence_bundle.get("reasoningDepth") if isinstance(evidence_bundle, dict) else None
    depth_hint = ""
    if isinstance(cognitive_depth, (int, float)):
        if cognitive_depth >= 3:
            depth_hint = "The client requested deep reasoning: connect signals, state uncertainties, separate observed vs predicted."
        elif cognitive_depth >= 2:
            depth_hint = "Use clear, structured reasoning; moderate length."

    turn_kind = evidence_bundle.get("turnKind") if isinstance(evidence_bundle, dict) else None
    turn_hint = ""
    if turn_kind == "casual":
        turn_hint = "Turn type: CASUAL or greeting — keep it short, warm, human; no farm brief unless the user asked."
    elif turn_kind == "clarify":
        turn_hint = "Turn type: CLARIFY — user was vague about symptoms; prefer 1–2 sharp questions over conclusions."

    directives = ""
    companion = evidence_bundle.get("companion") if isinstance(evidence_bundle, dict) else None
    if isinstance(companion, dict):
        d = companion.get("directives")
        if isinstance(d, str) and d.strip():
            directives = f"\n\nPERSONALIZATION (from stored profile; do not contradict evidence):\n{d.strip()[:8000]}\n"

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
    system_instruction = "\n".join(p for p in system_parts if p)

    model = genai.GenerativeModel(model_name=model_id, system_instruction=system_instruction)
    generation_config = genai.types.GenerationConfig(
        temperature=float(os.environ.get("GEMINI_TEMPERATURE", "0.35")),
        max_output_tokens=int(os.environ.get("GEMINI_MAX_OUTPUT_TOKENS", "2048")),
    )

    resp = model.generate_content(
        q,
        generation_config=generation_config,
    )

    text = ""
    try:
        text = (resp.text or "").strip()
    except (ValueError, AttributeError):
        if resp.candidates:
            parts = []
            for c in resp.candidates:
                for p in c.content.parts if c.content else []:
                    if hasattr(p, "text") and p.text:
                        parts.append(p.text)
            text = "\n".join(parts).strip()

    if not text:
        text = "I could not produce a reply from the model. Check GEMINI_MODEL and API quota."

    return {
        "reply": text,
        "text": text,
        "model": model_id,
        "citations": [],
    }
