"""
Smart Agri — AI inference API with real YOLOv8 inference path.

Set AGRI_YOLO_WEIGHTS to a trained YOLOv8 .pt (Ultralytics) with your disease classes.
Without weights the endpoint returns HTTP 503 — no simulated labels.
"""

from __future__ import annotations

import json
import os
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from inference.yolo_engine import YOLOVisionEngine

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
    return {
        "ok": True,
        "service": APP_NAME,
        "model_loaded": eng.ok,
        "weights_configured": bool(w),
        "load_error": eng.load_error,
        "imgsz": eng.imgsz if eng.ok else int(os.environ.get("AGRI_YOLO_IMGSZ", "640")),
    }


@app.post("/v1/vision/disease")
async def vision_disease(
    file: UploadFile = File(...),
    context_json: str | None = Form(None),
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
    question: str
    locale: str = "en"
    evidenceBundle: dict[str, Any] = Field(default_factory=dict)


@app.post("/v1/chat/grounded")
async def chat_grounded(body: GroundedChatBody) -> dict[str, Any]:
    raise HTTPException(
        status_code=501,
        detail="LLM not configured. Implement provider call with server-side API keys.",
    )
