#!/usr/bin/env python3
"""
Convert raw conversation JSONL to instruction-tuning format.

Supported output formats:
  alpaca      {"instruction": ..., "input": ..., "output": ...}
  sharegpt    {"conversations": [{from, value}, ...]}
  openai      {"messages": [{role, content}, ...]}  (ChatML / OpenAI fine-tune)

Usage:
    python -m ml.llm.format_training_data \
        --input  ml/runs/llm/raw_conversations.jsonl \
        --output ml/runs/llm/train_sharegpt.jsonl \
        --format sharegpt

The script also:
  - Filters out conversations where the first user turn is empty.
  - Strips assistant turns that are just apologies / refusals (heuristic).
  - Truncates very long turns at 2048 chars.
  - Writes a train/val split (90 / 10) when --split is set.
"""

from __future__ import annotations

import argparse
import json
import logging
import random
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)s  %(message)s")
log = logging.getLogger("format_training_data")

MAX_TURN_CHARS = 2048
REFUSAL_PREFIXES = (
    "i'm sorry",
    "i cannot",
    "i can't",
    "as an ai",
    "i don't have access",
)


# ── Filtering ────────────────────────────────────────────────────────────────

def _is_refusal(text: str) -> bool:
    return any(text.lower().startswith(p) for p in REFUSAL_PREFIXES)


def _clean_messages(messages: list[dict]) -> list[dict]:
    out = []
    for m in messages:
        role    = m.get("role", "").lower()
        content = m.get("content", "").strip()[:MAX_TURN_CHARS]
        if not content:
            continue
        if role == "assistant" and _is_refusal(content):
            break  # truncate conversation at first refusal
        out.append({"role": role, "content": content})
    return out


# ── Formatters ───────────────────────────────────────────────────────────────

def to_openai(messages: list[dict]) -> dict:
    return {"messages": messages}


def to_sharegpt(messages: list[dict]) -> dict:
    role_map = {"user": "human", "assistant": "gpt", "system": "system"}
    return {
        "conversations": [
            {"from": role_map.get(m["role"], m["role"]), "value": m["content"]}
            for m in messages
        ]
    }


def to_alpaca(messages: list[dict]) -> list[dict]:
    """
    Yields one Alpaca sample per user/assistant turn pair.
    System prompt (if present) goes into every 'input'.
    """
    system = ""
    pairs = []
    clean = [m for m in messages if m["role"] in ("user", "assistant", "system")]
    for m in clean:
        if m["role"] == "system":
            system = m["content"]
    turns = [m for m in clean if m["role"] != "system"]
    for i in range(0, len(turns) - 1, 2):
        if turns[i]["role"] == "user" and turns[i + 1]["role"] == "assistant":
            pairs.append({
                "instruction": turns[i]["content"],
                "input": system,
                "output": turns[i + 1]["content"],
            })
    return pairs


FORMATTERS = {
    "openai":    to_openai,
    "sharegpt":  to_sharegpt,
}


# ── Main ─────────────────────────────────────────────────────────────────────

def main() -> None:
    ap = argparse.ArgumentParser(description="Format raw conversations for LLM fine-tuning")
    ap.add_argument("--input",  type=Path, default=ROOT / "ml" / "runs" / "llm" / "raw_conversations.jsonl")
    ap.add_argument("--output", type=Path, default=ROOT / "ml" / "runs" / "llm" / "train.jsonl")
    ap.add_argument(
        "--format",
        choices=["openai", "sharegpt", "alpaca"],
        default="sharegpt",
        help="Output instruction-tuning format",
    )
    ap.add_argument("--split", action="store_true", help="Also write a 90/10 train/val split")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    if not args.input.is_file():
        log.error("input file not found: %s", args.input)
        raise SystemExit(1)

    raw_lines = args.input.read_text(encoding="utf-8").splitlines()
    records: list[dict] = []

    for line in raw_lines:
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue

        messages = _clean_messages(obj.get("messages", []))
        user_turns = [m for m in messages if m["role"] == "user"]
        if not user_turns or not user_turns[0]["content"]:
            continue

        if args.format == "alpaca":
            records.extend(to_alpaca(messages))
        else:
            fmt = FORMATTERS[args.format]
            records.append(fmt(messages))

    log.info("formatted %d samples (format=%s)", len(records), args.format)

    if args.split:
        random.seed(args.seed)
        random.shuffle(records)
        split_idx = max(1, int(len(records) * 0.9))
        train_r, val_r = records[:split_idx], records[split_idx:]

        train_path = args.output.parent / (args.output.stem + "_train.jsonl")
        val_path   = args.output.parent / (args.output.stem + "_val.jsonl")
        _write_jsonl(train_r, train_path)
        _write_jsonl(val_r,   val_path)
        log.info("train=%d  val=%d → %s / %s", len(train_r), len(val_r), train_path, val_path)
    else:
        _write_jsonl(records, args.output)
        log.info("written → %s", args.output)


def _write_jsonl(records: list, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "\n".join(json.dumps(r, ensure_ascii=False) for r in records) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
