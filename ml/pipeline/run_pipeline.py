#!/usr/bin/env python3
"""
Unified AgroSphere training pipeline.

Chains all ML pipeline steps in order:
  ingest → validate → split → augment → balance_report → train → export → registry

Usage:
  python -m ml.pipeline.run_pipeline --data-zip path/to/roboflow.zip
  python -m ml.pipeline.run_pipeline --data-zip ... --from-step split  # resume
  python -m ml.pipeline.run_pipeline --data-zip ... --dry-run           # plan only

Environment:
  AGRI_PIPELINE_WORKDIR   Root for all pipeline outputs (default: ml/runs/pipeline)
  AGRI_YOLO_WEIGHTS       Pre-trained base weights (default: yolov8n.pt)
"""

from __future__ import annotations

import argparse
import hashlib
import json
import logging
import shutil
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("pipeline")

STEP_ORDER = ["ingest", "validate", "split", "augment", "balance", "train", "export", "registry"]


# ── Manifest ─────────────────────────────────────────────────────────────────

@dataclass
class StepResult:
    step: str
    ok: bool
    elapsed_s: float
    detail: dict[str, Any] = field(default_factory=dict)
    error: str | None = None


@dataclass
class PipelineManifest:
    pipeline_id: str
    data_zip: str
    dataset_hash: str
    start_ts: float
    workdir: str
    steps: list[StepResult] = field(default_factory=list)
    final_model: str | None = None

    def save(self, workdir: Path) -> None:
        out = workdir / "pipeline_manifest.json"
        out.write_text(
            json.dumps(
                {
                    "pipeline_id": self.pipeline_id,
                    "data_zip": self.data_zip,
                    "dataset_hash": self.dataset_hash,
                    "start_ts": self.start_ts,
                    "workdir": self.workdir,
                    "final_model": self.final_model,
                    "steps": [
                        {
                            "step": s.step,
                            "ok": s.ok,
                            "elapsed_s": round(s.elapsed_s, 2),
                            "detail": s.detail,
                            "error": s.error,
                        }
                        for s in self.steps
                    ],
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        log.info("Manifest saved → %s", out)


# ── Helpers ───────────────────────────────────────────────────────────────────

def _hash_file(p: Path, chunk: int = 1 << 20) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        while True:
            buf = f.read(chunk)
            if not buf:
                break
            h.update(buf)
    return h.hexdigest()[:16]


def _run_script(cmd: list[str], cwd: Path, step_name: str, dry_run: bool) -> StepResult:
    log.info("[%s] %s", step_name, " ".join(str(c) for c in cmd))
    if dry_run:
        return StepResult(step=step_name, ok=True, elapsed_s=0.0, detail={"dry_run": True})
    t0 = time.perf_counter()
    proc = subprocess.run(cmd, cwd=str(cwd), capture_output=False)
    elapsed = time.perf_counter() - t0
    ok = proc.returncode == 0
    err = None if ok else f"Exit code {proc.returncode}"
    return StepResult(step=step_name, ok=ok, elapsed_s=elapsed, error=err)


# ── Steps ─────────────────────────────────────────────────────────────────────

def step_ingest(workdir: Path, data_zip: Path, dry_run: bool) -> StepResult:
    raw_dir = workdir / "raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "ml.dataset.ingest_roboflow_zip", str(data_zip), "--out", str(raw_dir)]
    return _run_script(cmd, ROOT, "ingest", dry_run)


def step_validate(workdir: Path, dry_run: bool) -> StepResult:
    raw_dir = workdir / "raw"
    quarantine = workdir / "quarantine"
    cmd = [
        sys.executable, "-m", "ml.dataset.validate_yolo_dataset",
        "--images", str(raw_dir / "images"),
        "--labels", str(raw_dir / "labels"),
        "--quarantine", str(quarantine),
    ]
    return _run_script(cmd, ROOT, "validate", dry_run)


def step_split(workdir: Path, dry_run: bool) -> StepResult:
    raw_dir = workdir / "raw"
    split_dir = workdir / "split"
    cmd = [
        sys.executable, "-m", "ml.dataset.split_yolo",
        "--images", str(raw_dir / "images"),
        "--labels", str(raw_dir / "labels"),
        "--out", str(split_dir),
    ]
    return _run_script(cmd, ROOT, "split", dry_run)


def step_augment(workdir: Path, dry_run: bool) -> StepResult:
    split_dir = workdir / "split"
    cmd = [
        sys.executable, "-m", "ml.dataset.augment_offline",
        "--train-images", str(split_dir / "train" / "images"),
        "--train-labels", str(split_dir / "train" / "labels"),
    ]
    return _run_script(cmd, ROOT, "augment", dry_run)


def step_balance(workdir: Path, dry_run: bool) -> StepResult:
    split_dir = workdir / "split"
    weights_out = workdir / "class_weights.yaml"
    cmd = [
        sys.executable, "-m", "ml.dataset.balance_report",
        "--labels-dir", str(split_dir / "train" / "labels"),
        "--weights-out", str(weights_out),
    ]
    return _run_script(cmd, ROOT, "balance", dry_run)


def step_build_data_yaml(workdir: Path, dry_run: bool) -> StepResult:
    split_dir = workdir / "split"
    data_yaml = workdir / "data.yaml"
    cmd = [
        sys.executable, "-m", "ml.dataset.build_data_yaml",
        "--split-dir", str(split_dir),
        "--out", str(data_yaml),
    ]
    return _run_script(cmd, ROOT, "build_data_yaml", dry_run)


def step_train(workdir: Path, train_config: Path, dry_run: bool) -> StepResult:
    data_yaml = workdir / "data.yaml"
    exp_name = f"pipeline_{workdir.name}"
    weights_out = workdir / "class_weights.yaml"
    cmd = [
        sys.executable, "-m", "ml.training.train_yolov8",
        "--data", str(data_yaml),
        "--exp-name", exp_name,
        "--train-config", str(train_config),
    ]
    if weights_out.is_file():
        cmd += ["--cls-weights", str(weights_out)]
    result = _run_script(cmd, ROOT, "train", dry_run)
    # Capture best model path from metrics_summary.json
    metrics_path = ROOT / "ml" / "runs" / "detect" / exp_name / "metrics_summary.json"
    if metrics_path.is_file():
        try:
            summary = json.loads(metrics_path.read_text(encoding="utf-8"))
            result.detail["best_weights"] = summary.get("best_weights")
            result.detail["map50"] = summary.get("val_metrics", {}).get("map50")
        except Exception:
            pass
    return result


def step_export(workdir: Path, train_config: Path, dry_run: bool) -> StepResult:
    exp_name = f"pipeline_{workdir.name}"
    best = ROOT / "ml" / "runs" / "detect" / exp_name / "weights" / "best.pt"
    if not best.is_file() and not dry_run:
        return StepResult(
            step="export", ok=False, elapsed_s=0.0,
            error=f"best.pt not found at {best} — training may have failed",
        )
    cmd = [
        sys.executable, "-m", "ml.training.export_models",
        "--weights", str(best),
        "--out-dir", str(workdir / "export"),
    ]
    return _run_script(cmd, ROOT, "export", dry_run)


def step_registry(workdir: Path, dataset_hash: str, dry_run: bool) -> StepResult:
    exp_name = f"pipeline_{workdir.name}"
    metrics_path = ROOT / "ml" / "runs" / "detect" / exp_name / "metrics_summary.json"
    export_path = workdir / "export" / "export_registry.json"
    cmd = [
        sys.executable, "-m", "ml.versioning.append_registry",
        "--metrics", str(metrics_path),
        "--export", str(export_path),
        "--dataset-hash", dataset_hash,
    ]
    return _run_script(cmd, ROOT, "registry", dry_run)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="AgroSphere unified training pipeline")
    ap.add_argument("--data-zip", type=Path, help="Roboflow export zip (required for ingest step)")
    ap.add_argument(
        "--from-step",
        choices=STEP_ORDER,
        default=None,
        help="Resume from this step (skip earlier steps)",
    )
    ap.add_argument(
        "--only-step",
        choices=STEP_ORDER,
        default=None,
        help="Run only this one step",
    )
    ap.add_argument(
        "--train-config",
        type=Path,
        default=ROOT / "ml" / "config" / "train_defaults.yaml",
    )
    ap.add_argument(
        "--workdir",
        type=Path,
        default=None,
        help="Output directory (auto-generated if not specified)",
    )
    ap.add_argument("--dry-run", action="store_true", help="Plan steps but do not execute")
    args = ap.parse_args()

    # Resolve workdir
    workdir_base = Path(
        __import__("os").environ.get("AGRI_PIPELINE_WORKDIR", str(ROOT / "ml" / "runs" / "pipeline"))
    )
    workdir_base.mkdir(parents=True, exist_ok=True)
    run_id = f"run_{int(time.time())}"
    workdir: Path = args.workdir or (workdir_base / run_id)
    workdir.mkdir(parents=True, exist_ok=True)

    # Dataset hash
    dataset_hash = "unknown"
    if args.data_zip and Path(args.data_zip).is_file():
        dataset_hash = _hash_file(Path(args.data_zip))

    manifest = PipelineManifest(
        pipeline_id=run_id,
        data_zip=str(args.data_zip) if args.data_zip else "",
        dataset_hash=dataset_hash,
        start_ts=time.time(),
        workdir=str(workdir),
    )

    log.info("Pipeline %s  workdir=%s  dry_run=%s", run_id, workdir, args.dry_run)

    # Determine which steps to run
    start_idx = STEP_ORDER.index(args.from_step) if args.from_step else 0
    steps_to_run = [args.only_step] if args.only_step else STEP_ORDER[start_idx:]

    step_fns = {
        "ingest":   lambda: step_ingest(workdir, args.data_zip, args.dry_run),
        "validate": lambda: step_validate(workdir, args.dry_run),
        "split":    lambda: step_split(workdir, args.dry_run),
        "augment":  lambda: step_augment(workdir, args.dry_run),
        "balance":  lambda: step_balance(workdir, args.dry_run),
        # build_data_yaml runs between balance and train automatically
        "train":    lambda: (step_build_data_yaml(workdir, args.dry_run), step_train(workdir, args.train_config, args.dry_run))[-1],
        "export":   lambda: step_export(workdir, args.train_config, args.dry_run),
        "registry": lambda: step_registry(workdir, dataset_hash, args.dry_run),
    }

    failed = False
    for step_name in steps_to_run:
        fn = step_fns.get(step_name)
        if fn is None:
            log.warning("No handler for step '%s', skipping", step_name)
            continue
        result: StepResult = fn()
        manifest.steps.append(result)
        manifest.save(workdir)
        if result.ok:
            log.info("✓ %s  (%.1fs)", result.step, result.elapsed_s)
        else:
            log.error("✗ %s failed: %s", result.step, result.error)
            failed = True
            break

    # Capture final model path
    for s in reversed(manifest.steps):
        if s.detail.get("best_weights"):
            manifest.final_model = s.detail["best_weights"]
            break

    manifest.save(workdir)

    if failed:
        log.error("Pipeline aborted. Re-run with --from-step to resume. Manifest: %s", workdir / "pipeline_manifest.json")
        sys.exit(1)
    else:
        log.info("Pipeline complete. Manifest: %s", workdir / "pipeline_manifest.json")
        if manifest.final_model:
            log.info("Best model: %s", manifest.final_model)


if __name__ == "__main__":
    main()
