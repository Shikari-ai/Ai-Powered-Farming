"""
PlantNet plant identification engine.

Calls the Pl@ntNet API (my-api.plantnet.org) to identify what plant/crop
is in the image before disease detection runs.

Stage 1 of the 2-stage scan pipeline:
  PlantNet → "This is Solanum lycopersicum (Tomato)" [94% confidence]
  AgroNet  → "Early Blight detected" [82% confidence]

Set PLANTNET_API_KEY in server/.env to enable.
Free tier: 500 identifications/day.
"""

from __future__ import annotations

import logging
import os
from io import BytesIO
from typing import Optional

log = logging.getLogger("plantnet_engine")

# Common plant families / species → friendly crop name mapping
SPECIES_TO_CROP = {
    # Solanaceae
    "solanum lycopersicum": "Tomato",
    "solanum tuberosum":    "Potato",
    "capsicum annuum":      "Pepper / Chilli",
    "solanum melongena":    "Eggplant",
    # Poaceae (grasses)
    "triticum aestivum":    "Wheat",
    "oryza sativa":         "Rice",
    "zea mays":             "Maize / Corn",
    "saccharum officinarum":"Sugarcane",
    "sorghum bicolor":      "Sorghum",
    "pennisetum glaucum":   "Pearl Millet",
    "eleusine coracana":    "Finger Millet",
    # Legumes
    "glycine max":          "Soybean",
    "cicer arietinum":      "Chickpea",
    "arachis hypogaea":     "Groundnut / Peanut",
    "vigna radiata":        "Mung Bean",
    "vigna unguiculata":    "Cowpea",
    "phaseolus vulgaris":   "Common Bean",
    "lens culinaris":       "Lentil",
    # Malvaceae
    "gossypium hirsutum":   "Cotton",
    "gossypium arboreum":   "Desi Cotton",
    # Fruits
    "mangifera indica":     "Mango",
    "musa acuminata":       "Banana",
    "carica papaya":        "Papaya",
    "citrus sinensis":      "Orange",
    "citrus limon":         "Lemon",
    "citrus reticulata":    "Mandarin",
    "vitis vinifera":       "Grape",
    "malus domestica":      "Apple",
    "prunus persica":       "Peach",
    # Brassicas
    "brassica oleracea":    "Cabbage / Cauliflower",
    "brassica napus":       "Rapeseed / Canola",
    "raphanus sativus":     "Radish",
    # Others
    "helianthus annuus":    "Sunflower",
    "allium cepa":          "Onion",
    "allium sativum":       "Garlic",
    "cucumis sativus":      "Cucumber",
    "cucurbita pepo":       "Pumpkin / Squash",
}


class PlantNetEngine:
    """Calls PlantNet API to identify plant species from an image."""

    ENDPOINT = "https://my-api.plantnet.org/v2/identify/all"

    def __init__(self):
        self.api_key = os.environ.get("PLANTNET_API_KEY", "").strip()
        self.ok = bool(self.api_key)
        if self.ok:
            log.info("PlantNet engine ready (API key configured)")
        else:
            log.warning("PlantNet engine disabled — set PLANTNET_API_KEY in server/.env")

    def identify(self, image_bytes: bytes) -> dict:
        """
        Identify plant species from image bytes.

        Returns:
            {
                "identified": True/False,
                "common_name": "Tomato",           # friendly name
                "scientific_name": "Solanum lycopersicum",
                "confidence": 0.94,                # 0-1
                "family": "Solanaceae",
                "all_results": [...]               # top 5 species
            }
        """
        if not self.ok:
            return {"identified": False, "reason": "PlantNet API key not configured"}

        try:
            import requests
        except ImportError:
            return {"identified": False, "reason": "requests library not installed"}

        try:
            files = [("images", ("image.jpg", BytesIO(image_bytes), "image/jpeg"))]
            params = {
                "api-key": self.api_key,
                "include-related-images": "false",
                "no-reject": "false",
                "lang": "en",
            }

            resp = requests.post(
                self.ENDPOINT,
                files=files,
                params=params,
                timeout=15,
            )

            if resp.status_code == 404:
                # No plant found / not a plant
                return {"identified": False, "reason": "No plant detected in image"}

            if resp.status_code == 429:
                return {"identified": False, "reason": "PlantNet daily limit reached (500/day)"}

            if resp.status_code != 200:
                log.warning("PlantNet API error %d: %s", resp.status_code, resp.text[:200])
                return {"identified": False, "reason": f"API error {resp.status_code}"}

            data = resp.json()
            results = data.get("results", [])

            if not results:
                return {"identified": False, "reason": "No species identified"}

            best = results[0]
            species_obj = best.get("species", {})
            sci_name = species_obj.get("scientificNameWithoutAuthor", "").lower()
            family   = species_obj.get("family", {}).get("scientificNameWithoutAuthor", "")
            score    = best.get("score", 0.0)

            # Look up friendly crop name
            common_name = None
            for key, name in SPECIES_TO_CROP.items():
                if key in sci_name or sci_name in key:
                    common_name = name
                    break

            # Fallback: use PlantNet's own common names
            if not common_name:
                common_names = species_obj.get("commonNames", [])
                if common_names:
                    common_name = common_names[0].capitalize()
                else:
                    common_name = sci_name.title()

            all_results = []
            for r in results[:5]:
                sp = r.get("species", {})
                all_results.append({
                    "scientific_name": sp.get("scientificNameWithoutAuthor", ""),
                    "common_names":    sp.get("commonNames", [])[:2],
                    "confidence":      round(r.get("score", 0), 3),
                    "family":          sp.get("family", {}).get("scientificNameWithoutAuthor", ""),
                })

            log.info("PlantNet: %s (%s) score=%.3f", sci_name, common_name, score)

            return {
                "identified":       True,
                "common_name":      common_name,
                "scientific_name":  sci_name.title(),
                "confidence":       round(score, 3),
                "family":           family,
                "all_results":      all_results,
            }

        except Exception as e:
            log.error("PlantNet identification error: %s", e)
            return {"identified": False, "reason": str(e)}
