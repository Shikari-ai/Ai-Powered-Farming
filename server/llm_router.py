"""Pick Gemini vs GitHub Models based on LLM_PROVIDER and env."""

from __future__ import annotations

import os
from typing import Any


def llm_provider_effective() -> str:
    explicit = (os.environ.get("LLM_PROVIDER") or "").strip().lower()
    if explicit in ("github", "gemini"):
        return explicit
    has_github = bool(
        (os.environ.get("GITHUB_TOKEN") or os.environ.get("GITHUB_MODELS_TOKEN") or os.environ.get("GH_TOKEN") or "").strip()
    )
    if has_github:
        return "github"
    return "gemini"


def grounded_farm_reply_auto(
    *,
    question: str,
    locale: str,
    evidence_bundle: dict[str, Any],
) -> dict[str, Any]:
    prov = llm_provider_effective()
    if prov == "github":
        from llm_github_models import grounded_farm_reply_github

        return grounded_farm_reply_github(
            question=question,
            locale=locale,
            evidence_bundle=evidence_bundle or {},
        )
    from llm_gemini import grounded_farm_reply

    return grounded_farm_reply(
        question=question,
        locale=locale,
        evidence_bundle=evidence_bundle or {},
    )
