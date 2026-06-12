#!/usr/bin/env python3
"""
One-shot PaDiM trainer for CI (GitHub Actions).

Unlike main.py (a long-lived FastAPI worker), this runs once, trains a model for a
single project + version, uploads the ONNX model, then exits. It is the "ephemeral
compute" half of the BIMS CV pipeline: BIMS dispatches a repository_dispatch event
-> GitHub spins up a runner -> this script runs -> the runner is destroyed.

It needs NO R2 credentials. BIMS (which holds the R2 creds in Vercel) hands the
runner everything at runtime over the authed manifest call: public image URLs to
download, and a Cloudflare-Worker upload target for the trained model.

Flow:
  1. GET  {BIMS_URL}/api/cv/train-manifest?projectId=..&version=..  (x-train-secret)
        -> { imageUrls, labels, modelKey, modelUploadUrl, modelUploadSecret }
  2. Download each image into good/ (approved) or bad/ (rejected).
  3. Train Anomalib PaDiM, export ONNX.
  4. PUT the ONNX to modelUploadUrl (X-Upload-Secret) -> lands in R2 at modelKey.
  5. Calibrate (shared calibration.py): score every labeled image with the
     exported ONNX -> scoreStats + F1-optimal calibratedThreshold + metrics.
  6. POST {BIMS_URL}/api/cv/train-complete  (x-train-secret)
        -> { projectId, version, status: 'trained'|'failed', message,
             calibratedThreshold, scoreStats, metrics, calibrationWarning }

Env (from the GitHub Actions workflow):
  BIMS_URL                 the Vercel deploy URL
  TRAIN_CALLBACK_SECRET    shared secret BIMS checks on manifest/complete
"""

import argparse
import json
import os
import shutil
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from calibration import calibrate, make_onnx_scorer, sanitize_for_json

BIMS_URL = os.environ["BIMS_URL"].rstrip("/")
TRAIN_CALLBACK_SECRET = os.environ["TRAIN_CALLBACK_SECRET"]
WORK_DIR = Path(os.environ.get("TRAINING_DATA_DIR", "/tmp/cv-training"))


def _bims_request(path: str, method: str = "GET", payload: dict | None = None) -> dict:
    url = f"{BIMS_URL}{path}"
    # allow_nan=False: never emit the literal token NaN/Infinity — that is
    # invalid JSON and the app would parse the body as {} and reject it.
    data = json.dumps(payload, allow_nan=False).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("x-train-secret", TRAIN_CALLBACK_SECRET)
    req.add_header("content-type", "application/json")
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


def fetch_manifest(project_id: str, version: str) -> dict:
    qs = urllib.parse.urlencode({"projectId": project_id, "version": version})
    return _bims_request(f"/api/cv/train-manifest?{qs}")


def report_complete(project_id: str, version: str, status: str, message: str, extra: dict | None = None):
    payload = {
        "projectId": project_id,
        "version": version,
        "status": status,
        "message": message,
    }
    if extra:
        payload.update(extra)
    # Belt and suspenders: calibrate() already refuses non-finite scores, but a
    # stray NaN/Inf anywhere in the payload must degrade to null, not to an
    # unparseable body that strands the trainedModels[] entry in 'training'.
    payload = sanitize_for_json(payload)
    try:
        _bims_request("/api/cv/train-complete", method="POST", payload=payload)
    except Exception as e:  # never let a callback failure mask the real error
        print(f"[train_cli] WARNING: failed to report completion: {e}", file=sys.stderr)


def download_image(url: str) -> bytes:
    return urllib.request.urlopen(url, timeout=60).read()


def upload_model(upload_url: str, upload_secret: str, data: bytes):
    req = urllib.request.Request(upload_url, data=data, method="PUT")
    req.add_header("X-Upload-Secret", upload_secret)
    req.add_header("Content-Type", "application/octet-stream")
    with urllib.request.urlopen(req, timeout=120) as resp:
        resp.read()


def train(project_id: str, version: str) -> dict:
    project_dir = WORK_DIR / project_id / version
    good_dir = project_dir / "good"
    bad_dir = project_dir / "bad"
    for d in (good_dir, bad_dir):
        d.mkdir(parents=True, exist_ok=True)

    manifest = fetch_manifest(project_id, version)
    image_urls = manifest.get("imageUrls", [])
    labels = manifest.get("labels", {})
    upload_url = manifest.get("modelUploadUrl")
    upload_secret = manifest.get("modelUploadSecret")
    if not upload_url:
        raise ValueError("manifest did not include modelUploadUrl")
    if len(image_urls) < 5:
        raise ValueError(f"Need at least 5 labeled images, got {len(image_urls)}")

    print(f"[train_cli] downloading {len(image_urls)} images for {project_id}@{version}")
    good_count = bad_count = 0
    for i, url in enumerate(image_urls):
        data = download_image(url)
        is_good = labels.get(url, "approved") == "approved"
        dest = good_dir if is_good else bad_dir
        (dest / f"img_{i:04d}.jpg").write_bytes(data)
        good_count += int(is_good)
        bad_count += int(not is_good)

    print(f"[train_cli] good(normal)={good_count} bad(abnormal)={bad_count}")
    if good_count == 0:
        raise ValueError("PaDiM needs at least one 'approved' (normal) image to model")

    # Heavy imports happen only here, after the cheap validation above.
    import torch
    from anomalib.data import Folder
    from anomalib.engine import Engine
    from anomalib.models import Padim

    accelerator = "gpu" if torch.cuda.is_available() else "cpu"
    print(f"[train_cli] training PaDiM on {accelerator}")

    model = Padim()
    datamodule = Folder(
        name=project_id,
        root=project_dir,
        normal_dir="good",
        abnormal_dir="bad",
        image_size=(256, 256),
        train_batch_size=4,
        eval_batch_size=4,
    )
    engine = Engine(
        accelerator=accelerator,
        max_epochs=1,
        default_root_dir=str(project_dir / "output"),
    )
    engine.fit(model=model, datamodule=datamodule)
    engine.export(model=model, export_type="onnx")

    onnx_path = next((project_dir / "output").rglob("*.onnx"), None)
    if not onnx_path:
        raise FileNotFoundError("ONNX export not found after training")

    upload_model(upload_url, upload_secret, onnx_path.read_bytes())
    print(f"[train_cli] uploaded model to {manifest.get('modelKey')}")

    # Calibration "final exam" (shared with the worker /train path): score every
    # labeled image with the exported ONNX, derive scoreStats + the F1-optimal
    # threshold. A calibration failure must not fail the run — the model is
    # already uploaded and usable via the legacy fallback path.
    try:
        scorer = make_onnx_scorer(onnx_path, 256)  # same input size as training above
        calibration = calibrate(
            scorer,
            sorted(good_dir.glob("*.jpg")),
            sorted(bad_dir.glob("*.jpg")),
        )
        print(
            f"[train_cli] calibratedThreshold={calibration.get('calibratedThreshold')} "
            f"metrics={calibration.get('metrics')} warning={calibration.get('calibrationWarning')}"
        )
    except Exception as e:
        print(f"[train_cli] WARNING: calibration failed: {e}", file=sys.stderr)
        calibration = {
            "calibratedThreshold": None,
            "scoreStats": None,
            "metrics": None,
            "calibrationWarning": f"calibration failed: {e}",
        }

    # Hygiene: drop training images + outputs now that the model is uploaded
    # and calibrated.
    shutil.rmtree(project_dir, ignore_errors=True)
    return calibration


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-id", required=True)
    parser.add_argument("--version", required=True)
    args = parser.parse_args()

    project_id = args.project_id
    version = args.version
    try:
        calibration = train(project_id, version)
        report_complete(project_id, version, "trained", "Training complete", extra=calibration)
        print("[train_cli] done")
    except Exception as e:
        print(f"[train_cli] FAILED: {e}", file=sys.stderr)
        report_complete(project_id, version, "failed", str(e))
        sys.exit(1)


if __name__ == "__main__":
    main()
