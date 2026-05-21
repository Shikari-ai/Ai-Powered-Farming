#!/usr/bin/env python3
"""
Train AgroNet — AgroSphere's custom crop disease classifier.

Dataset expected in classification layout (from prepare_classification.py):
    <data>/
      train/<class_name>/<img>
      val/<class_name>/<img>
      health_scores.yaml   (optional — provides regression labels)

Loss = CrossEntropy (classification) + λ * MSE (health score regression)

Usage:
    python -m ml.training.train_agronet \
        --data    ml/runs/pipeline/run_xxx/clf_dataset \
        --out     ml/runs/agronet \
        --epochs  60

Environment:
    AGRI_DEVICE   cuda | mps | cpu  (auto-detected if not set)
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import torch
import torch.nn as nn
from torch.utils.data import DataLoader
from torchvision import transforms
from torchvision.datasets import ImageFolder

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from ml.models.agro_net import AgroNet, AGRO_CLASSES, NUM_CLASSES, CLASS_HEALTH_BASE

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("train_agronet")


# ── Transforms ───────────────────────────────────────────────────────────────

IMAGENET_MEAN = [0.485, 0.456, 0.406]
IMAGENET_STD  = [0.229, 0.224, 0.225]

def train_transform():
    return transforms.Compose([
        transforms.Resize((256, 256)),
        transforms.RandomCrop(224),
        transforms.RandomHorizontalFlip(),
        transforms.RandomVerticalFlip(p=0.15),
        transforms.ColorJitter(brightness=0.3, contrast=0.3, saturation=0.3, hue=0.05),
        transforms.RandomRotation(15),
        transforms.RandomGrayscale(p=0.05),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])

def val_transform():
    return transforms.Compose([
        transforms.Resize((224, 224)),
        transforms.ToTensor(),
        transforms.Normalize(IMAGENET_MEAN, IMAGENET_STD),
    ])


# ── Health score lookup ───────────────────────────────────────────────────────

def _build_health_lookup(data_dir: Path) -> dict[str, float]:
    """Load explicit health scores yaml or fall back to class-based defaults."""
    import yaml
    score_yaml = data_dir / "health_scores.yaml"
    if score_yaml.is_file():
        raw = yaml.safe_load(score_yaml.read_text(encoding="utf-8")) or {}
        return {str(k): float(v) / 100.0 for k, v in raw.items()}
    return {}


class HealthScoreDataset(torch.utils.data.Dataset):
    """Wraps ImageFolder to also yield normalised health score (0–1)."""

    def __init__(self, folder: ImageFolder, health_lookup: dict[str, float]):
        self.inner   = folder
        self.lookup  = health_lookup
        # Class-name → default health (0–1)
        self._class_defaults = {
            cls: CLASS_HEALTH_BASE.get(cls, 55) / 100.0
            for cls in folder.classes
        }

    def __len__(self):
        return len(self.inner)

    def __getitem__(self, idx):
        img, cls_idx = self.inner[idx]
        path = Path(self.inner.samples[idx][0]).stem
        # Try per-image lookup first, else use class default
        health = self.lookup.get(path, self._class_defaults.get(self.inner.classes[cls_idx], 0.55))
        return img, cls_idx, torch.tensor(health, dtype=torch.float32)


# ── Training loop ─────────────────────────────────────────────────────────────

def train(args) -> None:
    device = args.device or ("cuda" if torch.cuda.is_available() else
                              "mps" if torch.backends.mps.is_available() else "cpu")
    log.info("Device: %s", device)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    # Datasets
    health_lookup = _build_health_lookup(Path(args.data))

    train_folder = ImageFolder(str(Path(args.data) / "train"), transform=train_transform())
    val_folder   = ImageFolder(str(Path(args.data) / "val"),   transform=val_transform())

    train_ds = HealthScoreDataset(train_folder, health_lookup)
    val_ds   = HealthScoreDataset(val_folder,   health_lookup)

    train_dl = DataLoader(train_ds, batch_size=args.batch, shuffle=True,
                          num_workers=args.workers, pin_memory=(device == "cuda"))
    val_dl   = DataLoader(val_ds,   batch_size=args.batch, shuffle=False,
                          num_workers=args.workers, pin_memory=(device == "cuda"))

    # Verify class alignment
    log.info("Dataset classes: %s", train_folder.classes)
    nc = len(train_folder.classes)

    # Model
    model = AgroNet(num_classes=nc, pretrained=True,
                    freeze_backbone_epochs=args.freeze_epochs).to(device)

    if args.freeze_epochs > 0:
        model.freeze_backbone()
        log.info("Backbone frozen for first %d epochs", args.freeze_epochs)

    # Loss functions
    cls_loss_fn    = nn.CrossEntropyLoss(label_smoothing=0.05)
    health_loss_fn = nn.MSELoss()
    health_lambda  = args.health_lambda

    # Optimizer — head and backbone get different LRs
    head_params     = list(model.disease_head.parameters()) + list(model.health_head.parameters())
    backbone_params = list(model.backbone.parameters())
    optimizer = torch.optim.AdamW([
        {"params": head_params,     "lr": args.lr},
        {"params": backbone_params, "lr": args.lr * 0.1},
    ], weight_decay=1e-4)

    scheduler = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=args.epochs, eta_min=1e-6)

    best_val_acc = 0.0
    best_path = out_dir / "agronet_best.pth"
    history = []

    for epoch in range(1, args.epochs + 1):
        # Unfreeze backbone after freeze_epochs
        if epoch == args.freeze_epochs + 1 and args.freeze_epochs > 0:
            model.unfreeze_backbone()
            log.info("Backbone unfrozen at epoch %d", epoch)

        # ── Train ──
        model.train()
        train_loss = train_cls = train_health = 0.0
        correct = total = 0

        for imgs, labels, health_gt in train_dl:
            imgs, labels, health_gt = imgs.to(device), labels.to(device), health_gt.to(device)
            optimizer.zero_grad()
            logits, health_pred = model(imgs)
            loss_cls    = cls_loss_fn(logits, labels)
            loss_health = health_loss_fn(health_pred / 100.0, health_gt)
            loss        = loss_cls + health_lambda * loss_health
            loss.backward()
            nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()

            train_loss   += loss.item()
            train_cls    += loss_cls.item()
            train_health += loss_health.item()
            correct += (logits.argmax(1) == labels).sum().item()
            total   += labels.size(0)

        scheduler.step()

        train_acc  = correct / total
        avg_loss   = train_loss / len(train_dl)

        # ── Validate ──
        model.eval()
        val_correct = val_total = 0
        val_loss = 0.0

        with torch.no_grad():
            for imgs, labels, health_gt in val_dl:
                imgs, labels, health_gt = imgs.to(device), labels.to(device), health_gt.to(device)
                logits, health_pred = model(imgs)
                loss_cls    = cls_loss_fn(logits, labels)
                loss_health = health_loss_fn(health_pred / 100.0, health_gt)
                val_loss   += (loss_cls + health_lambda * loss_health).item()
                val_correct += (logits.argmax(1) == labels).sum().item()
                val_total   += labels.size(0)

        val_acc = val_correct / val_total
        avg_val = val_loss / len(val_dl)

        log.info(
            "Epoch %3d/%d  train_loss=%.4f  train_acc=%.3f  val_loss=%.4f  val_acc=%.3f  lr=%.2e",
            epoch, args.epochs, avg_loss, train_acc, avg_val, val_acc,
            optimizer.param_groups[0]["lr"],
        )

        row = {
            "epoch": epoch, "train_loss": round(avg_loss, 4),
            "train_acc": round(train_acc, 4), "val_loss": round(avg_val, 4),
            "val_acc": round(val_acc, 4),
        }
        history.append(row)

        if val_acc > best_val_acc:
            best_val_acc = val_acc
            model.save(best_path, extra={"epoch": epoch, "val_acc": val_acc, "classes": train_folder.classes})
            log.info("  ✓ New best → %s  (val_acc=%.3f)", best_path, val_acc)

    # Save final
    final_path = out_dir / "agronet_final.pth"
    model.save(final_path, extra={"epoch": args.epochs, "val_acc": val_acc, "classes": train_folder.classes})

    # Metrics summary
    summary = {
        "best_val_acc": round(best_val_acc, 4),
        "best_weights": str(best_path),
        "final_weights": str(final_path),
        "epochs": args.epochs,
        "num_classes": nc,
        "classes": train_folder.classes,
        "history": history,
    }
    (out_dir / "metrics_summary.json").write_text(
        json.dumps(summary, indent=2), encoding="utf-8"
    )
    log.info("Training complete. Best val_acc=%.3f  →  %s", best_val_acc, best_path)


def main() -> None:
    ap = argparse.ArgumentParser(description="Train AgroNet crop disease classifier")
    ap.add_argument("--data",          type=Path, required=True)
    ap.add_argument("--out",           type=Path, default=ROOT / "ml" / "runs" / "agronet")
    ap.add_argument("--epochs",        type=int,  default=60)
    ap.add_argument("--batch",         type=int,  default=32)
    ap.add_argument("--lr",            type=float, default=1e-4)
    ap.add_argument("--workers",       type=int,  default=4)
    ap.add_argument("--freeze-epochs", type=int,  default=5,
                    help="Keep backbone frozen for this many initial epochs (head-only warmup)")
    ap.add_argument("--health-lambda", type=float, default=0.3,
                    help="Weight of health-score MSE loss relative to classification CE loss")
    ap.add_argument("--device",        type=str,  default=None,
                    help="cuda | mps | cpu (auto-detected if omitted)")
    args = ap.parse_args()
    train(args)


if __name__ == "__main__":
    main()
