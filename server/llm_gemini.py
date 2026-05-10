"""
Grounded farm assistant via Google Gemini (default: gemini-2.5-flash).

Requires GEMINI_API_KEY. Optional GEMINI_MODEL (e.g. gemini-2.5-flash).
Never log the API key.
"""

from __future__ import annotations

import os
from typing import Any

from llm_common import build_grounded_system_prompt

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
    system_instruction = build_grounded_system_prompt(
        locale=loc,
        evidence_bundle=evidence_bundle or {},
    )

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
        "provider": "gemini",
        "citations": [],
    }
