# Agricultural vision — dataset and training

Central definitions live in `ml/config/`:

- `crops.yaml` — supported crop slugs (extensible).
- `disease_classes.yaml` — `nc`, `names[]` (YOLO class order), and optional `classes{}` metadata.
- `dataset_policy.yaml` — quality thresholds, augmentation limits, split ratios.
- `train_defaults.yaml` — default Ultralytics train hyperparameters.

Clients send richer JSON as `context_json` (see `js/ai/vision-context.js`):

- `field_memory`: compact blocks built from `field_context_state` + scan frequency (no PII).
- `crop_slug`, `growth_stage`, `month`, `climate_profile`, Open-Meteo humidity/rain.

The FastAPI YOLO path merges this with `ml/config/growth_stages.yaml` and `context_intelligence.yaml` to damp unlikely crop/stage combinations, nudge confidence when environment + memory align, and emit `contextual_intel` (risk tier, explainable factors).

## End-to-end pipeline (YOLO)

Run from the **repository root** so `ml` is importable.

1. **Ingest** (optional): Roboflow zip → flat folders.

   ```bash
   python ml/dataset/ingest_roboflow_zip.py path/to/export.zip --out-dir data/my_crop_raw
   ```

2. **Validate** (quality, duplicates, label checks):

   ```bash
   python ml/dataset/validate_yolo_dataset.py data/my_crop_raw --out-report ml/runs/validate_report.json
   ```

3. **Stratified split** (dominant-class stratification):

   ```bash
   python ml/dataset/split_yolo.py data/my_crop_raw --out data/my_crop_split
   ```

4. **Class balance report** (optional weights YAML):

   ```bash
   python ml/dataset/balance_report.py data/my_crop_split
   ```

5. **Ultralytics `data.yaml`**:

   ```bash
   python ml/dataset/build_data_yaml.py data/my_crop_split
   ```

6. **Offline augmentation** (optional, train-only extra folder — see script help):

   ```bash
   python ml/dataset/augment_offline.py data/my_crop_split --factor 1
   ```

7. **Train** (writes `metrics_summary.json` and saves weights under `ml/runs/detect/<exp>/`):

   ```bash
   python ml/training/train_yolov8.py --data data/my_crop_split/data.yaml --exp-name my_run
   ```

8. **Export** (ONNX; optional TFLite if Ultralytics build supports it):

   ```bash
   python ml/training/export_models.py ml/runs/detect/my_run/weights/best.pt --imgsz 640
   ```

9. **Registry** (append-only audit line):

   ```bash
   python ml/versioning/append_registry.py ml/runs/detect/my_run/metrics_summary.json ml/runs/detect/my_run/weights/export_registry.json
   ```

## Environment

- Set `AGRI_YOLO_WEIGHTS` to the trained `best.pt` for the FastAPI server.
- Optional: `AGRI_METADATA_DIR` to override the path to the YAML config directory.

## Farmer feedback (retraining loop)

The web app can write documents to Firestore collection `vision_feedback` (see `firestore.rules`). Use `js/ai/vision-feedback.js` with the same `userId` pattern as other collections. Backend jobs can later export this collection for active learning.
