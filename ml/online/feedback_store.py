"""
SQLite-backed store for user scan corrections and label feedback.

Schema
------
feedback_events
  id          INTEGER PK AUTOINCREMENT
  created_at  REAL    (Unix timestamp)
  session_id  TEXT    (anonymised — e.g. SHA256[:12] of UID)
  image_path  TEXT    (path saved by the feedback bridge)
  original    TEXT    (model's predicted label)
  corrected   TEXT    (user's correction; NULL if no correction)
  confidence  REAL    (model confidence at inference time)
  crop        TEXT    (crop type string, optional)
  used        INTEGER (0 = pending, 1 = consumed by retrain)

Usage
-----
  store = FeedbackStore()
  store.insert(session_id=..., image_path=..., original=..., confidence=0.72)
  store.insert(..., corrected="healthy_leaf")   # user correction
  store.pending_count()
  store.consume_batch(100)   # returns rows and marks them used
"""

from __future__ import annotations

import logging
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

log = logging.getLogger(__name__)

DEFAULT_DB = Path(__file__).resolve().parents[2] / "ml" / "runs" / "feedback.db"


@dataclass
class FeedbackRow:
    id: int
    created_at: float
    session_id: str
    image_path: str
    original: str
    corrected: Optional[str]
    confidence: float
    crop: Optional[str]
    used: bool


class FeedbackStore:
    def __init__(self, db_path: Path = DEFAULT_DB) -> None:
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db_path = db_path
        self._init_schema()

    # ── internals ────────────────────────────────────────────────────────────

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _init_schema(self) -> None:
        with self._connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS feedback_events (
                    id          INTEGER PRIMARY KEY AUTOINCREMENT,
                    created_at  REAL    NOT NULL,
                    session_id  TEXT    NOT NULL,
                    image_path  TEXT    NOT NULL,
                    original    TEXT    NOT NULL,
                    corrected   TEXT,
                    confidence  REAL    NOT NULL DEFAULT 0.0,
                    crop        TEXT,
                    used        INTEGER NOT NULL DEFAULT 0
                )
                """
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_used ON feedback_events(used)"
            )
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_session ON feedback_events(session_id)"
            )

    # ── public API ───────────────────────────────────────────────────────────

    def insert(
        self,
        *,
        session_id: str,
        image_path: str,
        original: str,
        confidence: float,
        corrected: Optional[str] = None,
        crop: Optional[str] = None,
    ) -> int:
        """Insert one feedback event. Returns the new row id."""
        with self._connect() as conn:
            cur = conn.execute(
                """
                INSERT INTO feedback_events
                    (created_at, session_id, image_path, original, corrected, confidence, crop)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (time.time(), session_id, image_path, original, corrected, confidence, crop),
            )
            log.debug("feedback insert id=%d original=%s corrected=%s", cur.lastrowid, original, corrected)
            return cur.lastrowid  # type: ignore[return-value]

    def update_correction(self, row_id: int, corrected: str) -> None:
        """Allow a correction to be added after initial ingest (e.g. async user edit)."""
        with self._connect() as conn:
            conn.execute(
                "UPDATE feedback_events SET corrected = ? WHERE id = ?",
                (corrected, row_id),
            )

    def pending_count(self) -> int:
        """Number of unconsumed feedback rows."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM feedback_events WHERE used = 0"
            ).fetchone()
            return row[0]

    def corrections_count(self) -> int:
        """Rows where the user actually provided a correction."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT COUNT(*) FROM feedback_events WHERE used = 0 AND corrected IS NOT NULL"
            ).fetchone()
            return row[0]

    def consume_batch(self, limit: int = 200) -> list[FeedbackRow]:
        """
        Return up to `limit` unconsumed rows and mark them used atomically.
        Only rows with an explicit correction are eligible for training.
        """
        with self._connect() as conn:
            rows = conn.execute(
                """
                SELECT * FROM feedback_events
                WHERE used = 0 AND corrected IS NOT NULL
                ORDER BY created_at ASC
                LIMIT ?
                """,
                (limit,),
            ).fetchall()
            if not rows:
                return []
            ids = [r["id"] for r in rows]
            conn.execute(
                f"UPDATE feedback_events SET used = 1 WHERE id IN ({','.join('?' * len(ids))})",
                ids,
            )
            return [
                FeedbackRow(
                    id=r["id"],
                    created_at=r["created_at"],
                    session_id=r["session_id"],
                    image_path=r["image_path"],
                    original=r["original"],
                    corrected=r["corrected"],
                    confidence=r["confidence"],
                    crop=r["crop"],
                    used=bool(r["used"]),
                )
                for r in rows
            ]

    def stats(self) -> dict:
        with self._connect() as conn:
            total = conn.execute("SELECT COUNT(*) FROM feedback_events").fetchone()[0]
            pending = conn.execute(
                "SELECT COUNT(*) FROM feedback_events WHERE used = 0"
            ).fetchone()[0]
            corrected = conn.execute(
                "SELECT COUNT(*) FROM feedback_events WHERE corrected IS NOT NULL"
            ).fetchone()[0]
            by_class = conn.execute(
                """
                SELECT corrected, COUNT(*) as cnt
                FROM feedback_events
                WHERE corrected IS NOT NULL AND used = 0
                GROUP BY corrected
                ORDER BY cnt DESC
                """
            ).fetchall()
        return {
            "total": total,
            "pending": pending,
            "corrected_pending": corrected,
            "by_class": {r["corrected"]: r["cnt"] for r in by_class},
        }
