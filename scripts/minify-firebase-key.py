#!/usr/bin/env python3
"""Minify a Firebase service account JSON to one line for GitHub Actions secrets.

Usage (from repo root):
  python scripts/minify-firebase-key.py "C:\\Users\\YOU\\Downloads\\your-project-firebase-adminsdk-xxxxx.json"

Copy the printed line into secret FIREBASE_SERVICE_ACCOUNT. Do not commit the .json file.
"""
from __future__ import annotations

import json
import sys


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: python scripts/minify-firebase-key.py <path-to-service-account.json>", file=sys.stderr)
        sys.exit(2)
    path = sys.argv[1]
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("type") != "service_account":
        print("Warning: JSON does not look like a service account key.", file=sys.stderr)
    # Compact, single line; no ASCII-only escape needed for GitHub
    line = json.dumps(data, separators=(",", ":"), ensure_ascii=False)
    print(line)


if __name__ == "__main__":
    main()
