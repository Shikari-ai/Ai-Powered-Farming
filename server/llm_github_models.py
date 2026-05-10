"""
Grounded farm assistant via GitHub Models (OpenAI-compatible chat completions).

Env:
  GITHUB_TOKEN or GITHUB_MODELS_TOKEN — fine-grained PAT with models:read (see GitHub Models docs).
  GITHUB_MODEL — e.g. openai/gpt-4o, openai/gpt-4.1, microsoft/phi-4-mini-instruct, meta/llama-3.3-70b-instruct
  GITHUB_TEMPERATURE (optional, default 0.35)
  GITHUB_MAX_TOKENS (optional, default 2048)

API: https://models.github.ai/inference/chat/completions
"""

from __future__ import annotations

import os
from typing import Any

import httpx

from llm_common import build_grounded_system_prompt

GITHUB_CHAT_URL = "https://models.github.ai/inference/chat/completions"
GITHUB_API_VERSION = os.environ.get("GITHUB_API_VERSION", "2026-03-10").strip() or "2026-03-10"


def grounded_farm_reply(
    *,
    question: str,
    locale: str,
    evidence_bundle: dict[str, Any],
) -> dict[str, Any]:
    token = (
        os.environ.get("GITHUB_TOKEN")
        or os.environ.get("GITHUB_MODELS_TOKEN")
        or os.environ.get("GH_TOKEN")
        or ""
    ).strip()
    if not token:
        raise ValueError(
            "Set GITHUB_TOKEN (or GITHUB_MODELS_TOKEN) with models:read for GitHub Models inference."
        )

    model = (os.environ.get("GITHUB_MODEL") or "openai/gpt-4o").strip() or "openai/gpt-4o"
    q = (question or "").strip() or "Summarize the farm evidence briefly."
    loc = (locale or "en").strip() or "en"
    system = build_grounded_system_prompt(locale=loc, evidence_bundle=evidence_bundle or {})

    temperature = float(os.environ.get("GITHUB_TEMPERATURE", "0.35"))
    max_tokens = int(os.environ.get("GITHUB_MAX_TOKENS", "2048"))

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": q},
        ],
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": False,
    }

    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
    }

    with httpx.Client(timeout=httpx.Timeout(120.0)) as client:
        resp = client.post(GITHUB_CHAT_URL, headers=headers, json=payload)

    if resp.status_code >= 400:
        detail = resp.text[:800] if resp.text else resp.reason_phrase
        raise RuntimeError(f"GitHub Models HTTP {resp.status_code}: {detail}")

    data = resp.json()
    choices = data.get("choices") if isinstance(data, dict) else None
    text = ""
    if isinstance(choices, list) and len(choices) > 0:
        msg = choices[0].get("message") if isinstance(choices[0], dict) else None
        if isinstance(msg, dict) and isinstance(msg.get("content"), str):
            text = msg["content"].strip()

    if not text:
        text = "I could not parse a reply from GitHub Models. Check GITHUB_MODEL id and API response."

    return {
        "reply": text,
        "text": text,
        "model": model,
        "provider": "llm",
        "citations": [],
    }
