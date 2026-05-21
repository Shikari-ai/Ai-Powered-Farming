"""
Background loop: watches the feedback SQLite DB, converts accumulated user
corrections into YOLO training samples, then triggers an incremental retrain.

Run as a long-lived process alongside the FastAPI server:
    python -m ml.online.user_data_loop

Environment:
    AGRI_FEEDBACK_MIN_SAMPLES   Minimum corrections before retrain fires (default: 50)
    AGRI_FEEDBACK_POLL_INTERVAL_S  Seconds between DB checks (default: 300)
    AGRI_PIPELINE_WORKDIR        Where training outputs go (default: ml/runs/pipeline)
    AGRI_YOLO_WEIGHTS            Base weights for incremental fine-tune
"""

from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.online.feedback_store import FeedbackStore

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("user_data_loop")

MIN_SAMPLES = int(os.environ.get("AGRI_FEEDBACK_MIN_SAMPLES", "50"))
POLL_INTERVAL = int(os.environ.get("AGRI_FEEDBACK_POLL_INTERVAL_S", "300"))


# ── YOLO label conversion ─────────────────────────────────────────────────────

def _class_index(label: str, class_list: list[str]) -> int | None:
    try:
        return class_list.index(label)
    except ValueError:
        return None


def _write_full_image_label(label_path: Path, class_idx: int) -> None:
    """Write a YOLO label that covers the whole image (one bounding box)."""
    label_path.write_text(f"{class_idx} 0.5 0.5 1.0 1.0\n", encoding="utf-8")


def build_mini_dataset(
    rows: list,
    out_dir: Path,
    class_list: list[str],
) -> Path | None:
    """
    Convert feedback rows to a YOLO-format dataset in `out_dir`.
    Returns the path to the generated data.yaml, or None if nothing usable.
    """
    images_dir = out_dir / "train" / "images"
    labels_dir = out_dir / "train" / "labels"
    images_dir.mkdir(parents=True, exist_ok=True)
    labels_dir.mkdir(parents=True, exist_ok=True)

    written = 0
    for row in rows:
        src = Path(row.image_path)
        if not src.is_file():
            log.warning("image missing, skipping: %s", src)
            continue
        idx = _class_index(row.corrected, class_list)
        if idx is None:
            log.warning("unknown class '%s', skipping", row.corrected)
            continue

        dest_img = images_dir / src.name
        shutil.copy2(src, dest_img)
        _write_full_image_label(labels_dir / (src.stem + ".txt"), idx)
        written += 1

    if written == 0:
        log.warning("no usable images in batch")
        return None

    # Minimal data.yaml — val mirrors train (tiny fine-tune, not full eval)
    data_yaml = out_dir / "data.yaml"
    data_yaml.write_text(
        yaml.dump(
            {
                "path": str(out_dir),
                "train": "train/images",
                "val": "train/images",
                "nc": len(class_list),
                "names": class_list,
            },
            default_flow_style=False,
        ),
        encoding="utf-8",
    )
    log.info("mini-dataset ready: %d samples → %s", written, out_dir)
    return data_yaml


# ── Retrain trigger ──────────────────────────────────────────────────────────

def _load_class_list() -> list[str]:
    cfg = ROOT / "ml" / "config" / "disease_classes.yaml"
    if cfg.is_file():
        data = yaml.safe_load(cfg.read_text(encoding="utf-8"))
        return data.get("names") or data.get("classes") or []
    return []


def trigger_incremental_retrain(rows: list) -> bool:
    """
    Build a mini YOLO dataset from corrected rows and launch an incremental
    fine-tune via run_pipeline.py --only-step train.
    Returns True on success.
    """
    class_list = _load_class_list()
    if not class_list:
        log.error("could not load class list — aborting retrain")
        return False

    ts = int(time.time())
    workdir = ROOT / "ml" / "runs" / "pipeline" / f"online_{ts}"
    workdir.mkdir(parents=True, exist_ok=True)

    data_yaml = build_mini_dataset(rows, workdir / "split", class_list)
    if data_yaml is None:
        return False

    # Copy data.yaml to workdir root (where run_pipeline expects it for train step)
    shutil.copy2(data_yaml, workdir / "data.yaml")

    train_config = ROOT / "ml" / "config" / "train_defaults.yaml"
    cmd = [
        sys.executable, "-m", "ml.training.train_yolov8",
        "--data", str(workdir / "data.yaml"),
        "--exp-name", f"online_{ts}",
        "--train-config", str(train_config),
        "--epochs", "20",      # short fine-tune on user data
    ]
    base_weights = os.environ.get("AGRI_YOLO_WEIGHTS", "")
    if base_weights and Path(base_weights).is_file():
        cmd += ["--weights", base_weights]

    log.info("launching incremental retrain: %s", " ".join(cmd))
    proc = subprocess.run(cmd, cwd=str(ROOT))
    if proc.returncode == 0:
        log.info("incremental retrain complete (online_%s)", ts)
        return True
    else:
        log.error("retrain exited with code %d", proc.returncode)
        return False


# ── Main loop ────────────────────────────────────────────────────────────────

def run_loop(store: FeedbackStore | None = None) -> None:
    store = store or FeedbackStore()
    log.info("user_data_loop started — min_samples=%d  poll=%ds", MIN_SAMPLES, POLL_INTERVAL)

    while True:
        try:
            n = store.corrections_count()
            log.debug("pending corrections: %d / %d", n, MIN_SAMPLES)

            if n >= MIN_SAMPLES:
                log.info("%d corrections accumulated — triggering retrain", n)
                batch = store.consume_batch(limit=n)
                if batch:
                    ok = trigger_incremental_retrain(batch)
                    if not ok:
                        log.error("retrain failed — batch consumed but model NOT updated")
                else:
                    log.warning("consume_batch returned empty despite count=%d", n)
        except Exception:
            log.exception("unhandled error in user_data_loop tick")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    run_loop()
