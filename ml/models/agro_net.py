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

# ── Class registry v2 — 55 classes covering any agricultural plant ────────────
AGRO_CLASSES = [
    # ── Rusts (fungal) ───────────────────────────────────────────────────────
    "wheat_stripe_rust",        # Puccinia striiformis — yellow rust on wheat
    "wheat_leaf_rust",          # Puccinia triticina
    "wheat_stem_rust",          # Puccinia graminis
    "corn_common_rust",         # Puccinia sorghi
    "soybean_rust",             # Phakopsora pachyrhizi
    "leaf_rust",                # generic rust (coffee, apple cedar, etc.)

    # ── Blights ──────────────────────────────────────────────────────────────
    "early_blight",             # Alternaria solani — tomato / potato
    "late_blight",              # Phytophthora infestans — tomato / potato
    "rice_blast",               # Magnaporthe oryzae — most destructive rice disease
    "rice_bacterial_blight",    # Xanthomonas oryzae pv. oryzae
    "corn_northern_blight",     # Exserohilum turcicum
    "fire_blight",              # Erwinia amylovora — apple / pear

    # ── Mildews ──────────────────────────────────────────────────────────────
    "powdery_mildew",           # Erysiphe spp. — universal across crops
    "downy_mildew",             # Peronospora / Plasmopara — grapes, cucurbits

    # ── Spots & Lesions ──────────────────────────────────────────────────────
    "bacterial_spot",           # Xanthomonas spp. — tomato / pepper / peach
    "septoria_leaf_spot",       # Septoria tritici (wheat) / lycopersici (tomato)
    "gray_leaf_spot",           # Cercospora zeae-maydis — corn
    "rice_brown_spot",          # Bipolaris oryzae
    "anthracnose",              # Colletotrichum spp. — mango / banana / beans
    "bacterial_canker",         # Pseudomonas syringae — citrus / stone fruits
    "leaf_scorch",              # Diplocarpon / Xylella — strawberry / olive
    "general_lesion",           # catch-all for unclassified spots

    # ── Wilt & Root diseases ─────────────────────────────────────────────────
    "fusarium_wilt",            # Fusarium oxysporum — tomato / banana / cotton
    "verticillium_wilt",        # Verticillium dahliae — potato / cotton
    "root_rot",                 # Pythium / Phytophthora — seedlings & roots
    "rice_sheath_blight",       # Rhizoctonia solani

    # ── Viral diseases ───────────────────────────────────────────────────────
    "mosaic_virus",             # TMV / CMV / BYMV — mottled yellowing
    "yellow_leaf_curl_virus",   # TYLCV — tomato
    "cotton_leaf_curl_virus",   # CLCuV — Pakistan/India cotton
    "banana_bunchy_top",        # BBTV — most destructive banana disease

    # ── Smuts & Scabs ────────────────────────────────────────────────────────
    "smut",                     # Ustilago spp. — corn / wheat / sugarcane
    "common_scab",              # Streptomyces scabiei — potato
    "sugarcane_red_rot",        # Colletotrichum falcatum

    # ── Crop-specific tropical diseases ──────────────────────────────────────
    "rice_tungro",              # Rice tungro virus complex
    "mango_anthracnose",        # Colletotrichum gloeosporioides
    "banana_sigatoka",          # Mycosphaerella fijiensis — black sigatoka
    "citrus_canker",            # Xanthomonas citri
    "citrus_greening",          # Huanglongbing (HLB) — Candidatus Liberibacter
    "cotton_bacterial_blight",  # Xanthomonas malvacearum

    # ── Nutrient deficiencies ─────────────────────────────────────────────────
    "nitrogen_deficiency",      # yellowing from base leaves upward
    "phosphorus_deficiency",    # purple/red tint on leaves
    "potassium_deficiency",     # brown leaf edges / scorching
    "iron_deficiency",          # interveinal chlorosis — yellowing between veins
    "magnesium_deficiency",     # interveinal chlorosis older leaves

    # ── Pest damage (expanded) ───────────────────────────────────────────────
    "pest_damage",              # generic / unclassified pest damage
    "pest_damage_caterpillar",  # armyworm / bollworm / stem borer
    "pest_damage_aphid",        # aphid / whitefly / mealybug colonies
    "pest_damage_mite",         # spider mite webbing + stippling
    "pest_damage_borer",        # fruit borer / stem borer entry holes
    "pest_damage_leafminer",    # serpentine leaf mines

    # ── Abiotic stress ───────────────────────────────────────────────────────
    "drought_stress",           # wilting + leaf curl + tip burn
    "waterlogging",             # yellowing + root suffocation symptoms
    "sunburn",                  # bleached / papery patches on fruit & leaves
    "frost_damage",             # water-soaked then necrotic patches

    # ── Healthy ──────────────────────────────────────────────────────────────
    "healthy_leaf",             # any healthy green leaf — any crop

    # ════════════════════════════════════════════════════════════════════════
    # v3 additions — 24 new classes (Round-3 scrape)
    # ════════════════════════════════════════════════════════════════════════

    # ── Micronutrient deficiencies ────────────────────────────────────────
    "zinc_deficiency",          # khaira disease rice / interveinal streak maize
    "sulfur_deficiency",        # uniform yellowing of young leaves — oilseeds
    "calcium_deficiency",       # blossom end rot / tip burn
    "boron_deficiency",         # hollow stem cauliflower / top rot sugarcane
    "manganese_deficiency",     # interveinal chlorosis — cereals, soybean
    "copper_deficiency",        # blueing die-back of wheat tips

    # ── India-critical fungal diseases ────────────────────────────────────
    "rice_false_smut",          # Ustilaginoidea virens — green spore balls
    "rice_sheath_rot",          # Sarocladium oryzae — brown rotting sheath
    "wheat_karnal_bunt",        # Tilletia indica — partial smut, quarantine
    "wheat_loose_smut",         # Ustilago tritici — black powder head
    "groundnut_leaf_spot",      # Cercospora / Phaeoisariopsis — Tikka disease
    "groundnut_rust",           # Puccinia arachidis — orange pustules
    "chickpea_blight",          # Ascochyta rabiei — dark necrotic lesions
    "mustard_alternaria_blight",# Alternaria brassicae — concentric ring spots

    # ── Vegetable & horticulture diseases ─────────────────────────────────
    "okra_yellow_vein_mosaic",  # YVMV — yellow network veins on bhindi
    "chilli_anthracnose",       # Colletotrichum capsici — fruit rot
    "brinjal_wilt",             # Ralstonia / Fusarium wilt of eggplant

    # ── Fruit crop diseases ───────────────────────────────────────────────
    "banana_fusarium_wilt",     # Fusarium oxysporum f.sp. cubense — Panama
    "mango_dieback",            # Lasiodiplodia theobromae — dead shoot tips

    # ── Additional pest damage ────────────────────────────────────────────
    "pest_damage_whitefly",     # Bemisia tabaci — silverleaf / sooty mold
    "pest_damage_thrips",       # Thrips spp. — silvering / stippling
    "pest_damage_locust",       # Schistocerca gregaria — mass defoliation

    # ── Abiotic stress ───────────────────────────────────────────────────
    "salinity_stress",          # marginal leaf scorch / tip burn — saline soil
    "heat_stress",              # grain shrivelling / pollen failure / scorch
]

NUM_CLASSES = len(AGRO_CLASSES)

# Health score baseline per class (0-100). Used as regression label fallback.
CLASS_HEALTH_BASE = {
    "wheat_stripe_rust":       30, "wheat_leaf_rust":         35,
    "wheat_stem_rust":         20, "corn_common_rust":         40,
    "soybean_rust":            35, "leaf_rust":                35,
    "early_blight":            40, "late_blight":              15,
    "rice_blast":              20, "rice_bacterial_blight":    25,
    "corn_northern_blight":    35, "fire_blight":              20,
    "powdery_mildew":          45, "downy_mildew":             40,
    "bacterial_spot":          30, "septoria_leaf_spot":       40,
    "gray_leaf_spot":          35, "rice_brown_spot":          40,
    "anthracnose":             35, "bacterial_canker":         25,
    "leaf_scorch":             45, "general_lesion":           50,
    "fusarium_wilt":           15, "verticillium_wilt":        20,
    "root_rot":                15, "rice_sheath_blight":       30,
    "mosaic_virus":            30, "yellow_leaf_curl_virus":   25,
    "cotton_leaf_curl_virus":  25, "banana_bunchy_top":        10,
    "smut":                    25, "common_scab":              45,
    "sugarcane_red_rot":       20, "rice_tungro":              15,
    "mango_anthracnose":       35, "banana_sigatoka":          30,
    "citrus_canker":           30, "citrus_greening":          15,
    "cotton_bacterial_blight": 25, "nitrogen_deficiency":      50,
    "phosphorus_deficiency":   50, "potassium_deficiency":     50,
    "iron_deficiency":         55, "magnesium_deficiency":     55,
    "pest_damage":             40,
    "pest_damage_caterpillar": 40, "pest_damage_aphid":        45,
    "pest_damage_mite":        45, "pest_damage_borer":        35,
    "pest_damage_leafminer":   50, "drought_stress":           40,
    "waterlogging":            35, "sunburn":                  60,
    "frost_damage":            30, "healthy_leaf":             95,

    # v3 additions ─────────────────────────────────────────────────────────────
    # Micronutrient deficiencies
    "zinc_deficiency":         55, "sulfur_deficiency":        55,
    "calcium_deficiency":      50, "boron_deficiency":         50,
    "manganese_deficiency":    55, "copper_deficiency":        55,
    # India-critical fungal diseases
    "rice_false_smut":         35, "rice_sheath_rot":          30,
    "wheat_karnal_bunt":       25, "wheat_loose_smut":         25,
    "groundnut_leaf_spot":     40, "groundnut_rust":           35,
    "chickpea_blight":         25, "mustard_alternaria_blight": 35,
    # Vegetable & horticulture
    "okra_yellow_vein_mosaic": 25, "chilli_anthracnose":       30,
    "brinjal_wilt":            20,
    # Fruit crop diseases
    "banana_fusarium_wilt":    15, "mango_dieback":            30,
    # Additional pest damage
    "pest_damage_whitefly":    40, "pest_damage_thrips":       45,
    "pest_damage_locust":      20,
    # Abiotic stress
    "salinity_stress":         40, "heat_stress":              40,
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
        # class list — set to sorted(AGRO_CLASSES) by default; overridden from
        # checkpoint by load() so predict() always uses the trained ordering.
        self.classes: list[str] = sorted(AGRO_CLASSES)

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
        Uses self.classes (set from checkpoint by load()) so label ordering
        always matches the alphabetical ImageFolder order used at training time.
        """
        self.eval()
        logits, health = self(x)
        probs = torch.softmax(logits, dim=-1)[0]
        top_idx = int(probs.argmax())
        classes = self.classes
        return {
            "class_id":    top_idx,
            "label":       classes[top_idx],
            "confidence":  float(probs[top_idx]),
            "health_score": float(health[0].clamp(0, 100)),
            "all_probs":   {classes[i]: float(probs[i]) for i in range(len(classes))},
        }

    # ── Serialisation ────────────────────────────────────────────────────────

    def save(self, path: str | Path, extra: Optional[dict] = None) -> None:
        path = Path(path)
        path.parent.mkdir(parents=True, exist_ok=True)
        torch.save(
            {
                "state_dict":  self.state_dict(),
                "num_classes": self.num_classes,
                "classes":     self.classes,   # exact training order (overridden by extra if caller passes it)
                **(extra or {}),
            },
            str(path),
        )

    @classmethod
    def load(cls, path: str | Path, device: str = "cpu") -> "AgroNet":
        ckpt = torch.load(str(path), map_location=device, weights_only=False)
        nc = ckpt.get("num_classes", NUM_CLASSES)
        model = cls(num_classes=nc, pretrained=False)
        model.load_state_dict(ckpt["state_dict"])
        # Restore the exact class ordering used during training so predict()
        # maps logit indices → correct label names.
        if "classes" in ckpt:
            model.classes = list(ckpt["classes"])
        model.to(device)
        model.eval()
        return model
