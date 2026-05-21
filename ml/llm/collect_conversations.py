#!/usr/bin/env python3
"""
Export Firestore chat logs to a local JSONL file for LLM fine-tuning.

Reads from the `saved_chat_sessions` collection (each doc has a `messages`
array of {role, content} objects) and writes raw conversations to disk.

Usage:
    python -m ml.llm.collect_conversations \
        --out ml/runs/llm/raw_conversations.jsonl \
        --min-turns 4

Environment:
    GOOGLE_APPLICATION_CREDENTIALS  Path to service-account JSON
    FIREBASE_PROJECT_ID             e.g. agritech-4d1ba
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("collect_conversations")


def _firestore_client():
    try:
        import firebase_admin
        from firebase_admin import credentials, firestore
    except ImportError:
        log.error("firebase-admin not installed. Run: pip install firebase-admin")
        sys.exit(1)

    if not firebase_admin._apps:
        cred_path = os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        project   = os.environ.get("FIREBASE_PROJECT_ID")
        if cred_path:
            cred = credentials.Certificate(cred_path)
            firebase_admin.initialize_app(cred, {"projectId": project} if project else {})
        else:
            firebase_admin.initialize_app(options={"projectId": project} if project else {})
    return firestore.client()


def collect(out_path: Path, min_turns: int, limit: int) -> int:
    db = _firestore_client()
    col_ref = db.collection("saved_chat_sessions")

    written = 0
    skipped = 0
    out_path.parent.mkdir(parents=True, exist_ok=True)

    query = col_ref.order_by("createdAt", direction="DESCENDING")
    if limit:
        query = query.limit(limit)

    with out_path.open("w", encoding="utf-8") as fh:
        for doc in query.stream():
            data = doc.to_dict() or {}
            messages = data.get("messages") or data.get("turns") or []
            if len(messages) < min_turns:
                skipped += 1
                continue
            # Normalise to [{role, content}]
            clean = []
            for m in messages:
                role    = str(m.get("role") or m.get("sender") or "").lower()
                content = str(m.get("content") or m.get("text") or "").strip()
                if role and content:
                    clean.append({"role": role, "content": content})
            if len(clean) < min_turns:
                skipped += 1
                continue
            fh.write(json.dumps({"id": doc.id, "messages": clean}, ensure_ascii=False) + "\n")
            written += 1

    log.info("exported %d conversations (%d skipped) → %s", written, skipped, out_path)
    return written


def main() -> None:
    ap = argparse.ArgumentParser(description="Export Firestore chat logs to JSONL")
    ap.add_argument("--out", type=Path, default=ROOT / "ml" / "runs" / "llm" / "raw_conversations.jsonl")
    ap.add_argument("--min-turns", type=int, default=4, help="Skip conversations shorter than this")
    ap.add_argument("--limit", type=int, default=0, help="Max docs to read (0 = all)")
    args = ap.parse_args()

    n = collect(args.out, args.min_turns, args.limit)
    if n == 0:
        log.warning("No conversations written — check credentials and collection name.")
        sys.exit(1)


if __name__ == "__main__":
    main()
