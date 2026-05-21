"""
AgroNet — Custom crop disease classifier with health scoring.

Architecture
────────────
Backbone : MobileNetV3-Small (ImageNet pre-trained via torchvision)
           — depthwise-separable convolutions, SE blocks, h-swish activations.
           Replaced final classifier with our own dual-head.

Disease head  : FC(576 → 256 → num_classes)  → probabilities
Health head   : FC(576 → 64 → 1)             → 0-100 health score

The dual-head design lets a single forward pass produce:
  1. Which disease (or healthy) is present
  2. An overall crop health score independent of the class label

Usage
─────
  from ml.models.agro_net import AgroNet, AGRO_CLASSES

  model = AgroNet(pretrained=True)          # training
  model = AgroNet.load("path/to/best.pth")  # inference

  logits, health = model(image_tensor)      # both heads together
  probs = torch.softmax(logits, dim=-1)
"""

from __future__ import annotations

import torch
import torch.nn as nn
from pathlib import Path
from typing import Optional

# ── Class registry (must match disease_classes.yaml order) ───────────────────
AGRO_CLASSES = [
    "leaf_rust",
    "early_blight",
    "late_blight",
    "powdery_mildew",
    "bacterial_spot",
    "nitrogen_deficiency",
    "potassium_deficiency",
    "healthy_leaf",
    "pest_damage",
    "general_lesion",
]
NUM_CLASSES = len(AGRO_CLASSES)

# Derived from disease_kb.yaml health_score_base — used to synthesise regression
# labels when no explicit health annotation is in the dataset.
CLASS_HEALTH_BASE = {
    "leaf_rust":             35,
    "early_blight":          40,
    "late_blight":           15,
    "powdery_mildew":        45,
    "bacterial_spot":        30,
    "nitrogen_deficiency":   50,
    "potassium_deficiency":  50,
    "healthy_leaf":          95,
    "pest_damage":           40,
    "general_lesion":        55,
}


# ── Backbone feature extractor ────────────────────────────────────────────────

def _build_backbone(pretrained: bool):
    """Return MobileNetV3-Small features + pooling layers + feature dim."""
    from torchvision.models import mobilenet_v3_small, MobileNet_V3_Small_Weights
    weights = MobileNet_V3_Small_Weights.IMAGENET1K_V1 if pretrained else None
    base = mobilenet_v3_small(weights=weights)
    # features = convolutional body; avgpool keeps spatial → (B, 576, 1, 1)
    return base.features, base.avgpool, 576


# ── Squeeze-and-Excitation attention (crop-region focus) ─────────────────────

class SEBlock(nn.Module):
    """Channel-wise SE attention to emphasise leaf-texture features."""
    def __init__(self, channels: int, reduction: int = 8):
        super().__init__()
        self.fc = nn.Sequential(
            nn.Linear(channels, channels // reduction, bias=False),
            nn.ReLU(inplace=True),
            nn.Linear(channels // reduction, channels, bias=False),
            nn.Sigmoid(),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        b, c = x.shape
        scale = self.fc(x)
        return x * scale


# ── Disease classification head ───────────────────────────────────────────────

class DiseaseHead(nn.Module):
    def __init__(self, in_features: int, num_classes: int):
        super().__init__()
        self.net = nn.Sequential(
            SEBlock(in_features),
            nn.Dropout(p=0.35),
            nn.Linear(in_features, 256),
            nn.Hardswish(),
            nn.Dropout(p=0.20),
            nn.Linear(256, num_classes),
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ── Health score regression head ──────────────────────────────────────────────

class HealthHead(nn.Module):
    """Regresses a 0-100 crop health score."""
    def __init__(self, in_features: int):
        super().__init__()
        self.net = nn.Sequential(
            nn.Dropout(p=0.25),
            nn.Linear(in_features, 64),
            nn.ReLU(inplace=True),
            nn.Linear(64, 1),
            nn.Sigmoid(),   # output 0–1; multiply by 100 at inference
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x).squeeze(-1) * 100.0


# ── AgroNet ───────────────────────────────────────────────────────────────────

class AgroNet(nn.Module):
    """
    AgroSphere custom crop scanner model.
    Input:  batch of images, shape (B, 3, 224, 224), ImageNet-normalised
    Output: (disease_logits [B, num_classes], health_score [B])
    """

    def __init__(
        self,
        num_classes: int = NUM_CLASSES,
        pretrained: bool = True,
        freeze_backbone_epochs: int = 0,
    ):
        super().__init__()
        self.num_classes = num_classes
        self._freeze_epochs = freeze_backbone_epochs

        self.backbone, self.pool, feat_dim = _build_backbone(pretrained)
        self.disease_head = DiseaseHead(feat_dim, num_classes)
        self.health_head  = HealthHead(feat_dim)

    def forward(self, x: torch.Tensor):
        feats = self.backbone(x)          # (B, 576, H, W)
        feats = self.pool(feats)          # (B, 576, 1, 1)
        feats = feats.flatten(1)          # (B, 576)
        logits = self.disease_head(feats) # (B, num_classes)
        health = self.health_head(feats)  # (B,)
        return logits, health

    # ── Convenience helpers ──────────────────────────────────────────────────

    def freeze_backbone(self) -> None:
        for p in self.backbone.parameters():
            p.requires_grad = False

    def unfreeze_backbone(self) -> None:
        for p in self.backbone.parameters():
            p.requires_grad = True

    @torch.no_grad()
    def predict(self, x: torch.Tensor) -> dict:
        """
        Single-image inference helper.
        x: (1, 3, 224, 224) on same device as model.
        Returns dict with class, confidence, health_score, all_probs.
        """
        self.eval()
        logits, health = self(x)
        probs = torch.softmax(logits, dim=-1)[0]
        top_idx = int(probs.argmax())
        return {
            "class_id":    top_idx,
            "label":       AGRO_CLASSES[top_idx],
            "confidence":  float(probs[top_idx]),
            "health_score": float(health[0].clamp(0, 100)),
            "all_probs":   {AGRO_CLASSES[i]: float(probs[i]) for i in range(len(AGRO_CLASSES))},
        }

    # ── Serialisation ────────────────────────────────────────────────────────

    def save(self, path: str | Path, extra: Optional[dict] = None) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "state_dict":  self.state_dict(),
                "num_classes": self.num_classes,
                "classes":     AGRO_CLASSES,
                **(extra or {}),
            },
            str(path),
        )

    @classmethod
    def load(cls, path: str | Path, device: str = "cpu") -> "AgroNet":
        ckpt = torch.load(str(path), map_location=device)
        nc = ckpt.get("num_classes", NUM_CLASSES)
        model = cls(num_classes=nc, pretrained=False)
        model.load_state_dict(ckpt["state_dict"])
        model.to(device)
        model.eval()
        return model
