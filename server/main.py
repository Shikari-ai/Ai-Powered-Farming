"""
Smart Agri — AI inference API with real YOLOv8 inference path.

Set AGRI_YOLO_WEIGHTS to a trained YOLOv8 .pt (Ultralytics) with your disease classes.
Without weights the endpoint returns HTTP 503 — no simulated labels.
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from inference.yolo_engine import YOLOVisionEngine
from llm_gemini import grounded_farm_reply
from ml_metadata import load_vision_metadata

# Load server/.env (gitignored) so GEMINI_API_KEY never needs hardcoding in code.
load_dotenv(Path(__file__).resolve().parent / ".env")

APP_NAME = "smart-agri-ai"
MAX_IMAGE_BYTES = int(os.environ.get("AGRI_MAX_IMAGE_MB", "12")) * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.vision_engine = YOLOVisionEngine()
    yield


app = FastAPI(title=APP_NAME, version="0.2.0", lifespan=lifespan)

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
    eng: YOLOVisionEngine = app.state.vision_engine
    w = os.environ.get("AGRI_YOLO_WEIGHTS", "")
    _gk = (os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY") or "").strip()
    _gm = (os.environ.get("GEMINI_MODEL", "gemini-1.5-flash") or "gemini-1.5-flash").strip()
    return {
        "ok": True,
        "service": APP_NAME,
        "model_loaded": eng.ok,
        "weights_configured": bool(w),
        "load_error": eng.load_error,
        "imgsz": eng.imgsz if eng.ok else int(os.environ.get("AGRI_YOLO_IMGSZ", "640")),
        "llm": {
            "provider": "gemini",
            "configured": bool(_gk),
            "model": _gm,
        },
    }


@app.get("/v1/vision/metadata")
def vision_metadata() -> dict[str, Any]:
    """Central class/crop/config for clients — avoids hardcoding labels in frontend builds."""
    return load_vision_metadata()


@app.post("/v1/vision/disease")
async def vision_disease(
    file: UploadFile = File(...),
    context_json: str | None = Form(None),
    tracking_id: str | None = Form(
        None,
        description="Optional id for server-side temporal smoothing of top hypothesis across frames.",
    ),
    conf_threshold: float | None = Form(None),
    iou_threshold: float | None = Form(None),
) -> dict[str, Any]:
    """
    Multipart image → YOLOv8 detections + reasoning + optional environmental fusion.

    Form fields:
      - file: image/jpeg or png
      - context_json: optional JSON with humidity_pct, rain_today_mm, temperature_c, etc.
    """
    eng: YOLOVisionEngine = app.state.vision_engine
    if not eng.ok:
        raise HTTPException(
            status_code=503,
            detail=eng.load_error or "Configure AGRI_YOLO_WEIGHTS with a trained YOLOv8 weights file.",
        )

    raw = await file.read()
    if not raw or len(raw) < 32:
        raise HTTPException(status_code=400, detail="Empty or too small image payload.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds configured size limit.")

    ctx: dict[str, Any] | None = None
    if context_json:
        try:
            ctx = json.loads(context_json)
            if not isinstance(ctx, dict):
                raise ValueError("context must be a JSON object")
        except (json.JSONDecodeError, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"Invalid context_json: {e}") from e
    if tracking_id and str(tracking_id).strip():
        ctx = ctx or {}
        ctx["smooth_tracking_id"] = str(tracking_id).strip()[:128]

    conf_threshold = float(os.environ.get("AGRI_CONF_DEFAULT", "0.65")) if conf_threshold is None else conf_threshold
    iou_threshold = float(os.environ.get("AGRI_IOU_DEFAULT", "0.45")) if iou_threshold is None else iou_threshold
    conf_threshold = max(0.05, min(0.95, conf_threshold))
    iou_threshold = max(0.1, min(0.95, iou_threshold))

    try:

        def _run() -> dict[str, Any]:
            return eng.predict(raw, conf_thres=conf_threshold, iou_thres=iou_threshold, context=ctx)

        out = await run_in_threadpool(_run)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    out["model_version"] = os.path.basename(eng.weights) if eng.weights else "unknown"
    return out


class GroundedChatBody(BaseModel):
    """Grounded chat request. evidenceBundle may include a \"companion\" object
    with personalized farmer memory/directives when the client runs adaptive UI."""

    question: str
    locale: str = "en"
    evidenceBundle: dict[str, Any] = Field(default_factory=dict)


@app.post("/v1/chat/grounded")
async def chat_grounded(body: GroundedChatBody) -> dict[str, Any]:
    """
    Grounded agricultural Q&A via Gemini (system prompt + evidenceBundle JSON).
    Set GEMINI_API_KEY on the server. Companion directives are read in llm_gemini.
    """

    def _run() -> dict[str, Any]:
        return grounded_farm_reply(
            question=body.question,
            locale=body.locale,
            evidence_bundle=dict(body.evidenceBundle or {}),
        )

    try:
        return await run_in_threadpool(_run)
    except ValueError as e:
        raise HTTPException(
            status_code=503,
            detail=str(e),
        ) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except Exception as e:
        raise HTTPException(
            status_code=502,
            detail=f"LLM request failed: {e}",
        ) from e
