"""
FastAPI router — user feedback endpoints.

Mount in main.py:
    from server.feedback_routes import router as feedback_router
    app.include_router(feedback_router, prefix="/v1/feedback")
"""

from __future__ import annotations

import hashlib
import logging
import os
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from pydantic import BaseModel

from ml.online.feedback_store import FeedbackStore

log = logging.getLogger(__name__)

router = APIRouter(tags=["feedback"])

# Singleton store — one DB per server process
_store = FeedbackStore()

IMAGES_DIR = Path(__file__).resolve().parents[1] / "ml" / "runs" / "feedback_images"
IMAGES_DIR.mkdir(parents=True, exist_ok=True)


# ── Schemas ──────────────────────────────────────────────────────────────────

class ScanFeedbackIn(BaseModel):
    session_id: str        # anonymised (client hashes UID)
    original: str          # model prediction
    confidence: float
    corrected: Optional[str] = None
    crop: Optional[str] = None


class LabelFeedbackIn(BaseModel):
    row_id: int
    corrected: str


class FeedbackOut(BaseModel):
    row_id: int
    message: str


# ── Routes ───────────────────────────────────────────────────────────────────

@router.post("/scan", response_model=FeedbackOut)
async def post_scan_feedback(
    session_id: str = Form(...),
    original: str = Form(...),
    confidence: float = Form(...),
    corrected: Optional[str] = Form(None),
    crop: Optional[str] = Form(None),
    image: Optional[UploadFile] = File(None),
) -> FeedbackOut:
    """
    Accept an anonymised scan result + optional user correction.
    The image (if provided) is saved to disk for later training.
    """
    image_path = ""
    if image and image.filename:
        data = await image.read()
        # Filename: sha256[:12]_original.ext — avoids PII in path
        digest = hashlib.sha256(data).hexdigest()[:12]
        ext = Path(image.filename).suffix or ".jpg"
        fname = f"{digest}_{original}{ext}"
        dest = IMAGES_DIR / fname
        dest.write_bytes(data)
        image_path = str(dest)
        log.info("feedback image saved: %s", dest)

    row_id = _store.insert(
        session_id=session_id,
        image_path=image_path,
        original=original,
        confidence=confidence,
        corrected=corrected,
        crop=crop,
    )
    return FeedbackOut(row_id=row_id, message="ok")


@router.post("/label", response_model=FeedbackOut)
async def post_label_correction(body: LabelFeedbackIn) -> FeedbackOut:
    """
    Update an existing feedback row with a user-supplied correction label.
    Used when the user edits their classification after initial submission.
    """
    _store.update_correction(body.row_id, body.corrected)
    return FeedbackOut(row_id=body.row_id, message="correction saved")


@router.get("/stats")
async def get_stats() -> dict:
    """Overall feedback stats — used by the developer console."""
    return _store.stats()


@router.get("/pending-count")
async def get_pending_count() -> dict:
    """Quick count for the pipeline to decide whether to trigger retrain."""
    return {
        "pending": _store.pending_count(),
        "corrections": _store.corrections_count(),
    }
