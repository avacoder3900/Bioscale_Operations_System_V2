"""
BIMS CV Worker — Stripped-down FastAPI service for PaDiM training & ONNX inference.
Derived from iCast CV training_service.py + inference_service.py.
"""

import asyncio
import hashlib
import os
import shutil
import time
import threading
from enum import Enum
from pathlib import Path
from typing import Optional

import boto3
import numpy as np
import onnxruntime as ort
from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from calibration import calibrate, make_onnx_scorer, preprocess_image, sanitize_for_json

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

R2_ACCOUNT_ID = os.getenv("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.getenv("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.getenv("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.getenv("R2_BUCKET_NAME", "brevitest-cv")
R2_PUBLIC_URL = os.getenv("R2_PUBLIC_URL", "")
MODEL_INPUT_SIZE = int(os.getenv("MODEL_INPUT_SIZE", "256"))
CONFIDENCE_THRESHOLD = float(os.getenv("CONFIDENCE_THRESHOLD", "0.5"))
TRAINING_DATA_DIR = Path(os.getenv("TRAINING_DATA_DIR", "/tmp/cv-training"))
CV_WORKER_SECRET = os.getenv("CV_WORKER_SECRET", "")

# Train-complete callback (PRD CV-VERDICT-CALIBRATION-AND-GATING §5b step 5):
# BOTH training paths converge on POST {BIMS_URL}/api/cv/train-complete with the
# shared TRAIN_CALLBACK_SECRET — same contract as train_cli.report_complete.
BIMS_URL = os.getenv("BIMS_URL", "").rstrip("/")
TRAIN_CALLBACK_SECRET = os.getenv("TRAIN_CALLBACK_SECRET", "")

# ---------------------------------------------------------------------------
# Auth — shared secret on every endpoint except /health (Fly checks)
# ---------------------------------------------------------------------------

_no_secret_warned = False


def require_cv_secret(x_cv_secret: Optional[str] = Header(default=None, alias="X-CV-Secret")):
    """Require X-CV-Secret == CV_WORKER_SECRET.

    When the env var is unset (local dev), allow everything but log a warning
    once so an unauthenticated production deploy is at least visible.
    """
    global _no_secret_warned
    if not CV_WORKER_SECRET:
        if not _no_secret_warned:
            _no_secret_warned = True
            print("[cv-worker] WARNING: CV_WORKER_SECRET is not set — endpoints are unauthenticated (local dev only)")
        return
    if x_cv_secret != CV_WORKER_SECRET:
        raise HTTPException(401, "Unauthorized")

# ---------------------------------------------------------------------------
# R2 helpers
# ---------------------------------------------------------------------------

def _s3_client():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def download_from_r2(key: str) -> bytes:
    resp = _s3_client().get_object(Bucket=R2_BUCKET_NAME, Key=key)
    return resp["Body"].read()


def upload_to_r2(data: bytes, key: str, content_type: str = "application/octet-stream"):
    _s3_client().put_object(Bucket=R2_BUCKET_NAME, Key=key, Body=data, ContentType=content_type)

# ---------------------------------------------------------------------------
# ONNX model cache (LRU-capped; preprocessing shared with calibration.py)
# ---------------------------------------------------------------------------

MODEL_CACHE_MAX = 8

_model_cache: dict[str, tuple[ort.InferenceSession, float]] = {}  # path -> (session, last_use)
_cache_lock = threading.Lock()


def get_onnx_session(model_path: str) -> ort.InferenceSession:
    with _cache_lock:
        if model_path in _model_cache:
            session = _model_cache[model_path][0]
            _model_cache[model_path] = (session, time.time())  # refresh last-use
            return session
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    with _cache_lock:
        _model_cache[model_path] = (session, time.time())
        while len(_model_cache) > MODEL_CACHE_MAX:
            oldest = min(_model_cache, key=lambda k: _model_cache[k][1])
            del _model_cache[oldest]
    return session


def model_cache_path(r2_key: str) -> Path:
    """Local cache filename for a model R2 key — SHA-1 hashed to avoid the
    replace('/', '_') collisions between keys like a/b_c and a_b/c."""
    return TRAINING_DATA_DIR / "models" / (hashlib.sha1(r2_key.encode()).hexdigest() + ".onnx")

# ---------------------------------------------------------------------------
# Training state
# ---------------------------------------------------------------------------

class TrainingState(str, Enum):
    IDLE = "idle"
    TRAINING = "training"
    COMPLETE = "complete"
    FAILED = "failed"


_training_status: dict[str, dict] = {}
_training_lock = threading.Lock()

# ---------------------------------------------------------------------------
# Request / Response models
# ---------------------------------------------------------------------------

class TrainRequest(BaseModel):
    project_id: str
    imageUrls: list[str]
    labels: dict[str, str]  # url -> "approved" | "rejected"
    modelOutputKey: str
    # trainedModels[] version this run mints. Optional for back-compat: when
    # absent it is derived from modelOutputKey ("cv/<pid>/models/<version>.onnx").
    version: Optional[str] = None


class ScoreStats(BaseModel):
    rawMin: float
    rawMax: float


class InferRequest(BaseModel):
    image_url: str
    model_path: str  # R2 key to ONNX model
    confidence_threshold: float | None = None  # Per-call override of CONFIDENCE_THRESHOLD env
    score_stats: ScoreStats | None = None  # Calibration stats from the trainedModels[] entry


class TrainStatusResponse(BaseModel):
    project_id: str
    status: str
    progress: float = 0.0
    message: str = ""
    # Calibration results (populated when status == complete). Persisted by the
    # worker itself POSTing /api/cv/train-complete at the end of _run_training
    # (same callback + secret as train_cli.py); /status is only a transient
    # in-memory view for polling/debugging and is lost on restart.
    calibratedThreshold: float | None = None
    scoreStats: dict | None = None
    metrics: dict | None = None
    calibrationWarning: str | None = None

# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------

app = FastAPI(title="BIMS CV Worker", version="1.0.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "healthy"}


# ---- Training -------------------------------------------------------------

def _report_train_complete(project_id: str, version: str, status: str, message: str, extra: dict | None = None):
    """POST the run outcome (+ calibration) to the app's train-complete callback.

    Same contract and secret as train_cli.report_complete, so BOTH training
    paths converge on /api/cv/train-complete (PRD §5b step 5) and the
    trainedModels[] entry is flipped out of 'training'. Best-effort: a callback
    failure must never fail the training run itself.
    """
    if not BIMS_URL or not TRAIN_CALLBACK_SECRET:
        print(
            "[cv-worker] WARNING: BIMS_URL/TRAIN_CALLBACK_SECRET not set — "
            "train-complete callback skipped; results live only in the in-memory /status"
        )
        return
    import json
    import urllib.request

    payload = {"projectId": project_id, "version": version, "status": status, "message": message}
    if extra:
        payload.update(extra)
    payload = sanitize_for_json(payload)
    req = urllib.request.Request(
        f"{BIMS_URL}/api/cv/train-complete",
        data=json.dumps(payload, allow_nan=False).encode(),
        method="POST",
    )
    req.add_header("x-train-secret", TRAIN_CALLBACK_SECRET)
    req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            resp.read()
    except Exception as e:
        print(f"[cv-worker] WARNING: train-complete callback failed: {e}")


def _run_training(req: TrainRequest):
    """Background training task using Anomalib PaDiM."""
    project_id = req.project_id
    # Version for the train-complete callback; the app names model keys
    # "cv/<projectId>/models/<version>.onnx", so the stem is the version.
    version = req.version or Path(req.modelOutputKey).stem
    try:
        with _training_lock:
            _training_status[project_id] = {
                "status": TrainingState.TRAINING,
                "progress": 0.0,
                "message": "Downloading images...",
            }

        # Prepare directory structure: normal_dir (approved), abnormal_dir (rejected)
        project_dir = TRAINING_DATA_DIR / project_id
        normal_dir = project_dir / "good"
        abnormal_dir = project_dir / "bad"
        normal_dir.mkdir(parents=True, exist_ok=True)
        abnormal_dir.mkdir(parents=True, exist_ok=True)

        # Download images from R2
        for i, url in enumerate(req.imageUrls):
            label = req.labels.get(url, "approved")
            # Extract R2 key from public URL
            key = url.split("/", 3)[-1] if "/" in url else url
            try:
                data = download_from_r2(key)
            except Exception:
                # Try downloading via HTTP if it's a full URL
                import urllib.request
                data = urllib.request.urlopen(url).read()

            dest = normal_dir if label == "approved" else abnormal_dir
            dest_file = dest / f"img_{i:04d}.jpg"
            dest_file.write_bytes(data)

            with _training_lock:
                _training_status[project_id]["progress"] = 0.1 + (0.3 * (i + 1) / len(req.imageUrls))
                _training_status[project_id]["message"] = f"Downloaded {i + 1}/{len(req.imageUrls)} images"

        with _training_lock:
            _training_status[project_id]["progress"] = 0.4
            _training_status[project_id]["message"] = "Starting PaDiM training..."

        # Train with Anomalib
        import torch
        from anomalib.data import Folder
        from anomalib.engine import Engine
        from anomalib.models import Padim

        accelerator = "mps" if torch.backends.mps.is_available() else "cpu"

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

        with _training_lock:
            _training_status[project_id]["progress"] = 0.5
            _training_status[project_id]["message"] = "Training PaDiM model..."

        engine.fit(model=model, datamodule=datamodule)

        with _training_lock:
            _training_status[project_id]["progress"] = 0.8
            _training_status[project_id]["message"] = "Exporting ONNX model..."

        engine.export(model=model, export_type="onnx")

        # Find exported ONNX file
        onnx_path = None
        for p in (project_dir / "output").rglob("*.onnx"):
            onnx_path = p
            break

        if not onnx_path:
            raise FileNotFoundError("ONNX export not found after training")

        # Upload to R2
        with _training_lock:
            _training_status[project_id]["progress"] = 0.9
            _training_status[project_id]["message"] = "Uploading model to R2..."

        upload_to_r2(onnx_path.read_bytes(), req.modelOutputKey, "application/octet-stream")

        # Calibration "final exam" (PRD §5b): score every labeled image with the
        # exported ONNX, derive scoreStats + F1-optimal threshold. A calibration
        # failure must not fail the training — the model is already uploaded and
        # usable via the legacy fallback path.
        with _training_lock:
            _training_status[project_id]["progress"] = 0.95
            _training_status[project_id]["message"] = "Calibrating threshold..."

        try:
            scorer = make_onnx_scorer(onnx_path, MODEL_INPUT_SIZE)
            cal = calibrate(
                scorer,
                sorted(normal_dir.glob("*.jpg")),
                sorted(abnormal_dir.glob("*.jpg")),
            )
        except Exception as cal_err:
            cal = {
                "calibratedThreshold": None,
                "scoreStats": None,
                "metrics": None,
                "calibrationWarning": f"calibration failed: {cal_err}",
            }

        with _training_lock:
            _training_status[project_id] = {
                "status": TrainingState.COMPLETE,
                "progress": 1.0,
                "message": "Training complete",
                **cal,
            }

        # Persist the outcome on the app side (PRD §5b step 5: same callback,
        # same secret as the GH Actions path) — without this the calibration
        # only lives in the in-memory dict above and dies on restart.
        _report_train_complete(project_id, version, "trained", "Training complete", extra=cal)

        # Hygiene: training images + outputs are no longer needed once the
        # model is uploaded and calibrated.
        shutil.rmtree(project_dir, ignore_errors=True)

    except Exception as e:
        with _training_lock:
            _training_status[project_id] = {
                "status": TrainingState.FAILED,
                "progress": 0.0,
                "message": str(e),
            }
        _report_train_complete(project_id, version, "failed", str(e))


@app.post("/train", dependencies=[Depends(require_cv_secret)])
async def train(req: TrainRequest):
    with _training_lock:
        current = _training_status.get(req.project_id, {})
        if current.get("status") == TrainingState.TRAINING:
            raise HTTPException(400, "Training already in progress for this project")

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_training, req)

    return {"project_id": req.project_id, "status": "training", "message": "Training started"}


@app.get("/status", dependencies=[Depends(require_cv_secret)])
async def status(project_id: str):
    with _training_lock:
        st = _training_status.get(project_id)
    if not st:
        return TrainStatusResponse(project_id=project_id, status="idle", message="No training started")
    return TrainStatusResponse(project_id=project_id, **st)


# ---- Inference ------------------------------------------------------------

@app.post("/infer", dependencies=[Depends(require_cv_secret)])
async def infer(req: InferRequest):
    try:
        # Download model from R2 to local cache
        model_local = model_cache_path(req.model_path)
        if not model_local.exists():
            model_local.parent.mkdir(parents=True, exist_ok=True)
            model_data = download_from_r2(req.model_path)
            model_local.write_bytes(model_data)

        # Download image
        key = req.image_url.split("/", 3)[-1] if "/" in req.image_url else req.image_url
        try:
            image_data = download_from_r2(key)
        except Exception:
            import urllib.request
            image_data = urllib.request.urlopen(req.image_url).read()

        # Preprocess and run
        start = time.time()
        input_tensor = preprocess_image(image_data, MODEL_INPUT_SIZE)
        session = get_onnx_session(str(model_local))

        input_name = session.get_inputs()[0].name
        outputs = session.run(None, {input_name: input_tensor})

        raw_score = float(outputs[0].flatten()[0])
        if req.score_stats is not None:
            # Calibrated path: min-max normalize with the model's training-time
            # score stats, clamped to [0, 1]. No sigmoid.
            denom = req.score_stats.rawMax - req.score_stats.rawMin
            if denom > 0:
                normalized_score = (raw_score - req.score_stats.rawMin) / denom
            else:
                normalized_score = 0.0 if raw_score <= req.score_stats.rawMin else 1.0
            normalized_score = min(max(normalized_score, 0.0), 1.0)
        else:
            # Legacy path (uncalibrated model entries): conditional sigmoid,
            # unchanged for back-compat.
            normalized_score = raw_score
            if normalized_score < 0 or normalized_score > 1:
                normalized_score = 1.0 / (1.0 + np.exp(-normalized_score))

        threshold = req.confidence_threshold if req.confidence_threshold is not None else CONFIDENCE_THRESHOLD
        is_anomalous = normalized_score >= threshold
        elapsed_ms = (time.time() - start) * 1000

        return {
            "result": "fail" if is_anomalous else "pass",
            "confidence": round(1.0 - normalized_score if not is_anomalous else normalized_score, 4),
            "raw_score": round(raw_score, 6),
            "normalized_score": round(normalized_score, 4),
            "anomaly_score": round(normalized_score, 4),  # back-compat alias for normalized_score
            "is_anomalous": is_anomalous,
            "threshold": round(threshold, 4),
            "processing_time_ms": round(elapsed_ms, 1),
            "defects": [{"type": "anomaly", "location": "global", "severity": "high"}] if is_anomalous else [],
        }
    except Exception as e:
        raise HTTPException(500, str(e))


# ---- Image Processing (LIZA pipeline) ------------------------------------

class ProcessRequest(BaseModel):
    image_url: str          # R2 key or full URL
    output_key: str         # Where to save processed image in R2
    mode: str = "full"      # "full" (5-step LIZA) or "raw" (no processing)
    params: dict = {}       # Override defaults

class ProcessResponse(BaseModel):
    original_key: str
    processed_key: str
    width: int
    height: int
    processing_time_ms: float


# Default LIZA tuning parameters (from camera_capture.py)
LIZA_DEFAULTS = {
    "red_correction": 0.85,
    "green_correction": 0.90,
    "blue_correction": 1.0,
    "clahe_strength": 2.0,
    "gamma": 0.85,
}


def liza_process_frame(frame, params=None):
    """Exact replica of camera_capture.py process_frame() function."""
    import cv2

    p = {**LIZA_DEFAULTS, **(params or {})}

    # Step 1: Color correction
    b_ch, g_ch, r_ch = cv2.split(frame)
    r_ch = cv2.multiply(r_ch, p["red_correction"])
    g_ch = cv2.multiply(g_ch, p["green_correction"])
    b_ch = cv2.multiply(b_ch, p["blue_correction"])
    frame = cv2.merge([b_ch, g_ch, r_ch])

    # Step 2: Denoise (Gaussian blur 3x3)
    frame = cv2.GaussianBlur(frame, (3, 3), 0)

    # Step 3: CLAHE local contrast enhancement
    lab = cv2.cvtColor(frame, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(
        clipLimit=p["clahe_strength"], tileGridSize=(8, 8)
    )
    l = clahe.apply(l)
    frame = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)

    # Step 4: Gamma correction
    inv_gamma = 1.0 / p["gamma"]
    table = np.array([
        ((i / 255.0) ** inv_gamma) * 255 for i in range(256)
    ]).astype("uint8")
    frame = cv2.LUT(frame, table)

    # Step 5: Sharpen (unsharp mask kernel)
    kernel = np.array([[ 0, -1,  0],
                       [-1,  5, -1],
                       [ 0, -1,  0]])
    frame = cv2.filter2D(frame, -1, kernel)

    return frame


@app.post("/process-image", dependencies=[Depends(require_cv_secret)])
async def process_image(req: ProcessRequest):
    import cv2

    start = time.time()

    # Download image from R2
    key = req.image_url.split("/", 3)[-1] if "/" in req.image_url else req.image_url
    try:
        image_data = download_from_r2(key)
    except Exception:
        import urllib.request
        image_data = urllib.request.urlopen(req.image_url).read()

    # Decode image
    img_array = np.frombuffer(image_data, np.uint8)
    frame = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    if frame is None:
        raise HTTPException(400, "Could not decode image")

    # Apply processing
    if req.mode == "full":
        frame = liza_process_frame(frame, req.params if req.params else None)

    # Encode as PNG and upload
    _, buffer = cv2.imencode(".png", frame)
    upload_to_r2(buffer.tobytes(), req.output_key, "image/png")

    h, w = frame.shape[:2]
    elapsed_ms = (time.time() - start) * 1000

    return ProcessResponse(
        original_key=req.image_url,
        processed_key=req.output_key,
        width=w,
        height=h,
        processing_time_ms=round(elapsed_ms, 1),
    )
