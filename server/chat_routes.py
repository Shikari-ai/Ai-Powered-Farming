"""
Local Gemini chat endpoint — replaces the Val Town proxy entirely.

The API key lives in server/.env (GEMINI_API_KEY).
The browser never sees the key; it only talks to this server.

POST /v1/chat
  Body: { question, farmContext?, history?, forceProvider? }
  Returns: { reply, model, finish_reason }
"""

from __future__ import annotations

import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

log = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])

# ── Gemini SDK (lazy-loaded so the server starts without it if key absent) ──

_gemini_client = None


def _get_client():
    global _gemini_client
    if _gemini_client is not None:
        return _gemini_client
    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return None
    try:
        import google.generativeai as genai
        genai.configure(api_key=api_key)
        _gemini_client = genai
        return _gemini_client
    except ImportError:
        log.error("google-generativeai not installed — run: pip install google-generativeai")
        return None


# ── Schema ───────────────────────────────────────────────────────────────────

class HistoryTurn(BaseModel):
    role: str       # "user" | "assistant"
    text: str


class ChatRequest(BaseModel):
    question: str
    farmContext: Optional[dict[str, Any]] = None
    history: Optional[list[HistoryTurn]] = None
    forceProvider: Optional[str] = None   # reserved — ignored locally


class ChatResponse(BaseModel):
    reply: str
    model: str
    finish_reason: str


# ── System prompt ─────────────────────────────────────────────────────────────

def _build_system_prompt(farm_ctx: dict | None) -> str:
    base = (
        "You are AgroSphere AI, an expert agricultural assistant helping farmers "
        "with crop health, disease diagnosis, pest management, weather interpretation, "
        "and sustainable farming practices. "
        "Be concise, practical, and specific to the farmer's context. "
        "When uncertain, say so clearly rather than guessing."
    )
    if not farm_ctx:
        return base

    parts = [base, "\n\nFarm context:"]
    fields = farm_ctx.get("fields")
    if fields:
        names = ", ".join(
            f"{f.get('name','?')} ({f.get('cropType','?')})"
            for f in fields[:4]
        )
        parts.append(f"- Fields: {names}")

    scan = farm_ctx.get("latestScan")
    if scan:
        parts.append(
            f"- Latest scan: {scan.get('diagnosis','unknown')} "
            f"(health {scan.get('healthScore','?')}%)"
        )

    wx = farm_ctx.get("weather")
    if wx:
        parts.append(
            f"- Weather: {wx.get('tempC','?')}°C, "
            f"humidity {wx.get('rhPct','?')}%, "
            f"location: {wx.get('city') or farm_ctx.get('location',{}).get('city','unknown')}"
        )

    return "\n".join(parts)


# ── Model selection ──────────────────────────────────────────────────────────

def _pick_model() -> str:
    return os.environ.get("GEMINI_MODEL", "gemini-2.0-flash")


# ── Route ────────────────────────────────────────────────────────────────────

@router.post("/chat", response_model=ChatResponse)
async def post_chat(body: ChatRequest) -> ChatResponse:
    genai = _get_client()
    if genai is None:
        raise HTTPException(
            status_code=503,
            detail="Chat not configured. Set GEMINI_API_KEY in server/.env",
        )

    model_name = _pick_model()
    system_prompt = _build_system_prompt(body.farmContext)
    question = body.question.strip()[:4096]

    # Build Gemini contents list from history + new question
    contents = []
    for turn in (body.history or []):
        role = "user" if turn.role == "user" else "model"
        contents.append({"role": role, "parts": [{"text": turn.text[:2000]}]})
    contents.append({"role": "user", "parts": [{"text": question}]})

    try:
        model = genai.GenerativeModel(
            model_name=model_name,
            system_instruction=system_prompt,
        )
        response = model.generate_content(
            contents,
            generation_config={
                "temperature": 0.7,
                "top_p": 0.9,
                "max_output_tokens": 1024,
            },
        )
        reply = response.text.strip() if response.text else ""
        finish = (
            response.candidates[0].finish_reason.name
            if response.candidates
            else "STOP"
        )
    except Exception as e:
        log.error("Gemini call failed: %s", e)
        raise HTTPException(status_code=502, detail=f"Gemini error: {e}") from e

    return ChatResponse(reply=reply, model=model_name, finish_reason=finish)


@router.get("/chat/status")
async def chat_status() -> dict:
    """Quick check — does the server have a Gemini key configured?"""
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    return {
        "configured": bool(key),
        "model": _pick_model() if key else None,
    }
