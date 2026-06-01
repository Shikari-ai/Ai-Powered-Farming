python3 << 'PY'
import json
import os
import subprocess
import sys

def fail(msg: str) -> None:
    print(f"::error::{msg}")
    sys.exit(1)

workspace = os.environ["GITHUB_WORKSPACE"]
token = (os.environ.get("FIREBASE_TOKEN") or "").strip()
raw = (os.environ.get("FIREBASE_SERVICE_ACCOUNT") or "").lstrip("\ufeff").strip()

env = os.environ.copy()
project = "agritech-4d1ba"

if token:
    print("Auth: FIREBASE_TOKEN (login:ci)")
    env["FIREBASE_TOKEN"] = token
else:
    if not raw:
        fail("No credentials")
    data = json.loads(raw)
    path = os.path.join(workspace, "firebase-ci-sa.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f)
    env["GOOGLE_APPLICATION_CREDENTIALS"] = path

print("ok parse")
PY
