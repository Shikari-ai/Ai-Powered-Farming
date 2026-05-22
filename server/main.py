"""
Smart Agri — AI inference API.

Endpoints:
  POST /v1/scan            AgroNet crop scanner — disease + health score + KB (primary)
  POST /v1/vision/disease  YOLOv8 detection (secondary / bounding boxes)
  POST /v1/chat            Gemini-backed conversational assistant
  POST /v1/feedback/*      User scan corrections → training pipeline

Set AGRI_AGRONET_WEIGHTS for the custom scanner.
Set AGRI_YOLO_WEIGHTS for the YOLOv8 detection endpoint.
Set GEMINI_API_KEY for chat.
"""

from __future__ import annotations

import json
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

# Add project root to path so ml.* modules resolve when server runs from server/
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from dotenv import load_dotenv
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from starlette.concurrency import run_in_threadpool

from inference.yolo_engine import YOLOVisionEngine
from ml_metadata import load_vision_metadata
from feedback_routes import router as feedback_router
from chat_routes import router as chat_router
from inference.agronet_engine import AgroNetEngine
from inference.plantnet_engine import PlantNetEngine

load_dotenv(Path(__file__).resolve().parent / ".env")

APP_NAME = "smart-agri-ai"
MAX_IMAGE_BYTES = int(os.environ.get("AGRI_MAX_IMAGE_MB", "12")) * 1024 * 1024


@asynccontextmanager
async def lifespan(app: FastAPI):
    import logging as _log
    _l = _log.getLogger("startup")
    try:
        _l.info("Loading YOLOVisionEngine…")
        app.state.vision_engine = YOLOVisionEngine()
    except Exception as e:
        _l.error("YOLOVisionEngine init failed (non-fatal): %s", e)
        from inference.yolo_engine import YOLOVisionEngine as _Y
        app.state.vision_engine = object.__new__(_Y)
        app.state.vision_engine.ok = False
        app.state.vision_engine.load_error = str(e)
        app.state.vision_engine.weights = ""
    try:
        _l.info("Loading AgroNetEngine…")
        app.state.agronet_engine = AgroNetEngine()
    except Exception as e:
        _l.error("AgroNetEngine init failed (non-fatal): %s", e)
        from inference.agronet_engine import AgroNetEngine as _A
        app.state.agronet_engine = object.__new__(_A)
        app.state.agronet_engine.ok = False
        app.state.agronet_engine.load_error = str(e)
        app.state.agronet_engine.weights = ""
    try:
        _l.info("Loading PlantNetEngine…")
        app.state.plantnet_engine = PlantNetEngine()
    except Exception as e:
        _l.error("PlantNetEngine init failed (non-fatal): %s", e)
        from inference.plantnet_engine import PlantNetEngine as _P
        app.state.plantnet_engine = object.__new__(_P)
        app.state.plantnet_engine.ok = False
    _l.info("Startup complete. AgroNet ok=%s", app.state.agronet_engine.ok)
    yield


app = FastAPI(title=APP_NAME, version="0.4.0", lifespan=lifespan)

_cors = os.environ.get("AGRI_CORS_ORIGINS", "*")
app.include_router(feedback_router, prefix="/v1/feedback")
app.include_router(chat_router, prefix="/v1")

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors.split(",") if _cors else ["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.post("/v1/scan")
async def scan_crop(file: UploadFile = File(...)) -> dict[str, Any]:
    """
    2-stage plant scanner:
      Stage 1 — PlantNet:  identify what plant/crop is in the photo
      Stage 2 — AgroNet:   detect disease + health score

    Upload any plant photo → get:
      - plant identification (species + common name)
      - disease label + confidence
      - health score 0-100
      - symptoms, pesticide recommendations, prevention tips

    AgroNet requires AGRI_AGRONET_WEIGHTS in server/.env.
    PlantNet requires PLANTNET_API_KEY in server/.env (optional — enhances results).
    """
    eng:      AgroNetEngine    = app.state.agronet_engine
    plantnet: PlantNetEngine   = app.state.plantnet_engine

    if not eng.ok:
        raise HTTPException(
            status_code=503,
            detail=eng.load_error or "Set AGRI_AGRONET_WEIGHTS in server/.env to activate the crop scanner.",
        )

    raw = await file.read()
    if not raw or len(raw) < 32:
        raise HTTPException(status_code=400, detail="Empty or too-small image.")
    if len(raw) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image exceeds size limit.")

    try:
        # Stage 1: Plant identification (runs in parallel with Stage 2)
        async def _identify():
            if plantnet.ok:
                return await run_in_threadpool(plantnet.identify, raw)
            return {"identified": False, "reason": "PlantNet not configured"}

        # Stage 2: Disease detection
        def _scan():
            return eng.scan(raw)

        import asyncio
        plant_result, scan_result = await asyncio.gather(
            _identify(),
            run_in_threadpool(_scan),
        )

        # Merge results
        return {
            **scan_result,
            "plant_identification": plant_result,
        }

    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e


@app.get("/health")
def health() -> dict[str, Any]:
    yolo:    YOLOVisionEngine = app.state.vision_engine
    agronet: AgroNetEngine    = app.state.agronet_engine
    return {
        "ok":      True,
        "service": APP_NAME,
        "version": "0.4.0",
        "agronet": {
            "ok":     agronet.ok,
            "weights": os.path.basename(agronet.weights) if agronet.weights else None,
            "error":  agronet.load_error,
        },
        "yolo": {
            "ok":     yolo.ok,
            "weights": os.path.basename(yolo.weights) if yolo.ok and yolo.weights else None,
            "error":  yolo.load_error,
        },
        "chat": {
            "enabled": bool(os.environ.get("GEMINI_API_KEY", "").strip()),
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
