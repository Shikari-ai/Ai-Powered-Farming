"""
Smart Agri — AI inference API (FastAPI skeleton).

Deploy behind HTTPS. Load YOLOv8 / TF / TFLite / PyTorch weights in workers; keep inference off the UI thread.

Endpoints:
  GET  /health
  POST /v1/vision/disease   (multipart image → structured diagnosis; returns 503 until model wired)
  POST /v1/chat/grounded    (JSON evidence bundle → natural language; wire Gemini/OpenAI here)
"""

from __future__ import annotations

import os
from typing import Any

from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

APP_NAME = "smart-agri-ai"
MODEL_VERSION = os.environ.get("AGRI_MODEL_VERSION", "not-loaded")

app = FastAPI(title=APP_NAME, version="0.1.0")

_cors = os.environ.get("AGRI_CORS_ORIGINS", "*")
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors.split(",") if _cors else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict[str, Any]:
    return {"ok": True, "service": APP_NAME, "model_version": MODEL_VERSION}


@app.post("/v1/vision/disease")
async def vision_disease(file: UploadFile = File(...)) -> dict[str, Any]:
    """
    Replace with real decode → model → postprocess. Frontend expects JSON keys: model_version, top_hypothesis, confidence, explanation, treatments, mask_url.
    """
    await file.read()
    raise HTTPException(
        status_code=503,
        detail="Disease vision pipeline not implemented. Wire OpenCV + YOLOv8/TFLite and return structured JSON.",
    )


class GroundedChatBody(BaseModel):
    question: str
    locale: str = "en"
    evidenceBundle: dict[str, Any] = Field(default_factory=dict)


@app.post("/v1/chat/grounded")
async def chat_grounded(body: GroundedChatBody) -> dict[str, Any]:
    """
    Call Gemini / OpenAI here with `body.evidenceBundle` as grounded context.
    Never invent confidence for vision — only narrate supplied evidence.
    """
    raise HTTPException(
        status_code=501,
        detail="LLM not configured. Implement provider call with server-side API keys.",
    )
