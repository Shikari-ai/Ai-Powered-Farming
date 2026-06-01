"""Load merged vision metadata (YAML) for API + training scripts."""

from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


def _read_yaml(p: Path) -> dict[str, Any]:
    with p.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def metadata_root() -> Path:
    env = __import__("os").environ.get("AGRI_METADATA_DIR", "").strip()
    if env:
        return Path(env)
    # server/../ml/config when imported from repo root layouts
    here = Path(__file__).resolve()
    for parent in [here.parent, *here.parents]:
        cand = parent / "ml" / "config"
        if cand.is_dir():
            return cand
    return Path("ml/config")


def load_vision_metadata() -> dict[str, Any]:
    root = metadata_root()
    crops = _read_yaml(root / "crops.yaml")
    diseases = _read_yaml(root / "disease_classes.yaml")
    policy = _read_yaml(root / "dataset_policy.yaml")
    train_def = _read_yaml(root / "train_defaults.yaml")
    growth = _read_yaml(root / "growth_stages.yaml")
    intel = _read_yaml(root / "context_intelligence.yaml")
    return {
        "schema_version": diseases.get("schema_version", 1),
        "crops": crops.get("crops", []),
        "nc": diseases.get("nc", 0),
        "names": diseases.get("names", []),
        "class_metadata": diseases.get("classes", {}),
        "dataset_policy": policy,
        "train_defaults": train_def,
        "growth_stages": growth,
        "context_intelligence": intel,
        "metadata_source": str(root.resolve()),
    }
