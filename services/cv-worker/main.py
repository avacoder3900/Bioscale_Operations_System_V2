"""
BIMS CV Worker — Stripped-down FastAPI service for PaDiM training & ONNX inference.
Derived from iCast CV training_service.py + inference_service.py.
"""

import asyncio
import os
import time
import threading
from enum import Enum
from io import BytesIO
from pathlib import Path
from typing import Optional

import boto3
import numpy as np
import onnxruntime as ort
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from PIL import Image
from pydantic import BaseModel

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
# Image preprocessing (matches iCast inference_service.py)
# ---------------------------------------------------------------------------

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def preprocess_image(data: bytes, size: int = MODEL_INPUT_SIZE) -> np.ndarray:
    img = Image.open(BytesIO(data)).convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    return arr.transpose(2, 0, 1)[np.newaxis]  # NCHW

# ---------------------------------------------------------------------------
# ONNX model cache
# ---------------------------------------------------------------------------

_model_cache: dict[str, tuple[ort.InferenceSession, float]] = {}
_cache_lock = threading.Lock()


def get_onnx_session(model_path: str) -> ort.InferenceSession:
    with _cache_lock:
        if model_path in _model_cache:
            return _model_cache[model_path][0]
    session = ort.InferenceSession(model_path, providers=["CPUExecutionProvider"])
    with _cache_lock:
        _model_cache[model_path] = (session, time.time())
    return session

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


class InferRequest(BaseModel):
    image_url: str
    model_path: str  # R2 key to ONNX model


class TrainStatusResponse(BaseModel):
    project_id: str
    status: str
    progress: float = 0.0
    message: str = ""

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

def _run_training(req: TrainRequest):
    """Background training task using Anomalib PaDiM."""
    project_id = req.project_id
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

        with _training_lock:
            _training_status[project_id] = {
                "status": TrainingState.COMPLETE,
                "progress": 1.0,
                "message": "Training complete",
            }

    except Exception as e:
        with _training_lock:
            _training_status[project_id] = {
                "status": TrainingState.FAILED,
                "progress": 0.0,
                "message": str(e),
            }


@app.post("/train")
async def train(req: TrainRequest):
    with _training_lock:
        current = _training_status.get(req.project_id, {})
        if current.get("status") == TrainingState.TRAINING:
            raise HTTPException(400, "Training already in progress for this project")

    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _run_training, req)

    return {"project_id": req.project_id, "status": "training", "message": "Training started"}


@app.get("/status")
async def status(project_id: str):
    with _training_lock:
        st = _training_status.get(project_id)
    if not st:
        return TrainStatusResponse(project_id=project_id, status="idle", message="No training started")
    return TrainStatusResponse(project_id=project_id, **st)


# ---- Inference ------------------------------------------------------------

@app.post("/infer")
async def infer(req: InferRequest):
    try:
        # Download model from R2 to local cache
        model_local = TRAINING_DATA_DIR / "models" / req.model_path.replace("/", "_")
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
        input_tensor = preprocess_image(image_data)
        session = get_onnx_session(str(model_local))

        input_name = session.get_inputs()[0].name
        outputs = session.run(None, {input_name: input_tensor})

        anomaly_score = float(outputs[0].flatten()[0])
        # Normalize to 0-1 if needed
        if anomaly_score < 0 or anomaly_score > 1:
            anomaly_score = 1.0 / (1.0 + np.exp(-anomaly_score))

        is_anomalous = anomaly_score >= CONFIDENCE_THRESHOLD
        elapsed_ms = (time.time() - start) * 1000

        return {
            "result": "fail" if is_anomalous else "pass",
            "confidence": round(1.0 - anomaly_score if not is_anomalous else anomaly_score, 4),
            "anomaly_score": round(anomaly_score, 4),
            "is_anomalous": is_anomalous,
            "processing_time_ms": round(elapsed_ms, 1),
            "defects": [{"type": "anomaly", "location": "global", "severity": "high"}] if is_anomalous else [],
        }
    except Exception as e:
        raise HTTPException(500, str(e))
