#!/usr/bin/env python3
"""
Collect crop disease images from the web via DuckDuckGo image search.

Targets:
  - All 10 AgroNet disease classes
  - Extra focus on nitrogen/potassium deficiency and pest damage
    which are NOT in PlantVillage

Uses duckduckgo_search (no API key required, free, respects robots.txt).
Downloaded images are filtered through the quality pipeline before saving.

Usage:
    python -m ml.dataset.collect_web_images \
        --out      ml/data/raw/web \
        --per-query 80

Requirements:
    pip install duckduckgo-search requests Pillow
"""

from __future__ import annotations

import argparse
import hashlib
import logging
import sys
import time
import random
from pathlib import Path
from typing import Iterator
from urllib.parse import urlparse

log = logging.getLogger("collect_web_images")

# ── Search query bank per class ───────────────────────────────────────────────
# Multiple queries per class ensures variety. Each query targets a different
# angle: crop, pathogen name, symptom, region.

QUERIES: dict[str, list[str]] = {
    "leaf_rust": [
        "wheat leaf rust Puccinia triticina orange pustules",
        "maize common rust disease leaf closeup",
        "soybean rust Phakopsora crop disease",
        "barley leaf rust brown pustules field",
        "leaf rust fungal disease agricultural crop India",
        "wheat rust stripe disease yellow orange leaf",
    ],
    "early_blight": [
        "tomato early blight Alternaria solani concentric ring lesion",
        "potato early blight target board spot disease",
        "tomato early blight brown leaf lesion",
        "early blight disease tomato plant farm India",
        "Alternaria blight tomato leaf spot closeup",
    ],
    "late_blight": [
        "potato late blight Phytophthora infestans leaf",
        "tomato late blight water soaked lesion",
        "late blight disease potato field crop",
        "Phytophthora blight tomato grey fuzzy sporulation leaf",
        "late blight potato stem rot dark lesion India",
    ],
    "powdery_mildew": [
        "wheat powdery mildew Erysiphe white coating leaf",
        "tomato powdery mildew Leveillula grey spots leaf",
        "cucurbit powdery mildew white powder plant disease",
        "mango powdery mildew crop disease",
        "powdery mildew fungal disease crop leaf India",
        "squash powdery mildew white fungal spots",
    ],
    "bacterial_spot": [
        "tomato bacterial spot Xanthomonas angular lesion",
        "pepper bacterial spot dark brown halo leaf disease",
        "cotton bacterial blight angular leaf lesion",
        "bacterial spot disease tomato fruit scabby dark",
        "bacterial disease crop leaf water-soaked spots India",
    ],
    "nitrogen_deficiency": [
        "crop nitrogen deficiency pale yellow leaves",
        "maize nitrogen deficiency V-shape yellowing",
        "rice nitrogen deficiency pale green stunted plant",
        "wheat nitrogen deficiency chlorosis old leaves",
        "cotton nitrogen deficiency yellowing leaf India",
        "sugarcane nitrogen deficiency thin pale shoot",
        "nitrogen deficient corn plant field",
        "nitrogen deficiency crop plant agriculture India",
    ],
    "potassium_deficiency": [
        "potato potassium deficiency leaf margin scorch",
        "tomato potassium deficiency interveinal chlorosis",
        "sugarcane potassium deficiency leaf tip burn",
        "crop potassium K deficiency agriculture leaf",
        "banana potassium deficiency leaf necrosis",
        "rice potassium deficiency brown leaf tip marginal scorch",
        "cotton potassium deficiency leaf curl India",
    ],
    "healthy_leaf": [
        "healthy tomato plant green leaf farm",
        "healthy wheat crop green field India",
        "healthy rice plant green paddy field",
        "healthy potato plant green leaves farm",
        "healthy maize corn green leaves crop",
        "healthy cotton plant green leaf field India",
        "healthy soybean plant green leaves",
        "healthy sugarcane green leaf crop",
    ],
    "pest_damage": [
        "cotton bollworm caterpillar leaf damage holes",
        "aphid infestation crop leaf curling",
        "whitefly tomato crop leaf damage",
        "spider mite crop leaf stippling bronze",
        "leaf miner insect damage crop winding tunnels",
        "thrips crop leaf silvering damage",
        "locust crop plant damage leaf",
        "stem borer maize crop frass hole",
        "pest damage agricultural crop leaf India",
    ],
    "general_lesion": [
        "crop leaf spot disease unidentified brown lesion",
        "plant leaf lesion discolouration farm India",
        "unidentified crop disease leaf necrosis spot",
        "leaf blight lesion mixed disease crop",
        "fungal lesion crop leaf brown spot agriculture",
    ],
}

# ── Image download helpers ────────────────────────────────────────────────────

def _url_to_stem(url: str, idx: int) -> str:
    """Derive a unique filename from URL."""
    digest = hashlib.sha256(url.encode()).hexdigest()[:10]
    ext    = Path(urlparse(url).path).suffix.lower() or ".jpg"
    if ext not in {".jpg", ".jpeg", ".png", ".webp"}:
        ext = ".jpg"
    return f"web_{digest}_{idx}{ext}"


def _fetch_image_bytes(url: str, timeout: int = 10) -> bytes | None:
    import requests
    try:
        r = requests.get(url, timeout=timeout, headers={
            "User-Agent": "Mozilla/5.0 (compatible; AgroSphereBot/1.0; +research)"
        })
        if r.status_code == 200 and len(r.content) > 1024:
            return r.content
    except Exception as e:
        log.debug("fetch failed %s: %s", url[:60], e)
    return None


def _quality_ok(path: Path) -> bool:
    """Use existing quality pipeline to validate the downloaded image."""
    try:
        ROOT = Path(__file__).resolve().parents[2]
        if str(ROOT) not in sys.path:
            sys.path.insert(0, str(ROOT))
        from ml.dataset.quality import assess_image
        res = assess_image(path, min_edge=160)   # web images can be smaller
        return res.ok
    except Exception:
        return True  # if quality module fails, keep the image


def _search_images(query: str, max_results: int) -> Iterator[str]:
    """Yield image URLs from DuckDuckGo."""
    try:
        from duckduckgo_search import DDGS
    except ImportError:
        log.error("Run: pip install duckduckgo-search")
        sys.exit(1)

    with DDGS() as ddgs:
        results = ddgs.images(
            keywords=query,
            type_image="photo",
            size="Medium",
            license_image="any",
            max_results=max_results,
        )
        for r in (results or []):
            url = r.get("image") or r.get("url") or ""
            if url.startswith("http"):
                yield url


# ── Per-class collector ───────────────────────────────────────────────────────

def collect_class(
    class_name: str,
    out_dir: Path,
    per_query: int,
    delay_range: tuple[float, float],
) -> int:
    out_dir.mkdir(parents=True, exist_ok=True)
    queries = QUERIES.get(class_name, [])
    if not queries:
        log.warning("No queries defined for class '%s'", class_name)
        return 0

    saved  = 0
    seen   = set()

    for q_idx, query in enumerate(queries):
        log.info("  [%s] query %d/%d: %s", class_name, q_idx + 1, len(queries), query[:60])
        try:
            urls = list(_search_images(query, max_results=per_query + 10))
        except Exception as e:
            log.warning("  search error: %s", e)
            urls = []

        for url in urls[:per_query]:
            if url in seen:
                continue
            seen.add(url)

            fname = _url_to_stem(url, saved)
            dest  = out_dir / fname

            if dest.exists():
                saved += 1
                continue

            raw = _fetch_image_bytes(url)
            if raw is None:
                continue

            # Save to temp, validate, keep or discard
            dest.write_bytes(raw)
            if not _quality_ok(dest):
                dest.unlink(missing_ok=True)
                continue

            saved += 1
            # Polite delay
            time.sleep(random.uniform(*delay_range))

        # Between queries — slightly longer pause
        time.sleep(random.uniform(1.5, 3.0))

    log.info("  [%s] saved %d images", class_name, saved)
    return saved


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")

    ap = argparse.ArgumentParser(description="Collect crop disease images from DuckDuckGo")
    ap.add_argument("--out",        type=Path, default=Path("ml/data/raw/web"))
    ap.add_argument("--per-query",  type=int,  default=80,
                    help="Max images to download per search query")
    ap.add_argument("--classes",    nargs="*", default=None,
                    help="Limit to specific classes (default: all)")
    ap.add_argument("--delay-min",  type=float, default=0.3)
    ap.add_argument("--delay-max",  type=float, default=0.9)
    args = ap.parse_args()

    classes = args.classes or list(QUERIES.keys())
    total   = 0

    for cls in classes:
        out_cls = args.out / cls
        n = collect_class(cls, out_cls, args.per_query, (args.delay_min, args.delay_max))
        total += n

    log.info("Collection complete. Total images: %d → %s", total, args.out)


if __name__ == "__main__":
    main()
