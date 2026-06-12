"""
Vercel Python serverless function: ONNX cartridge inference.

The "always online" half of the BIMS CV pipeline. Lives in the SAME Vercel
project as the SvelteKit app, so it deploys with every push and is reached at
/api/ml/infer on the same domain — no separate worker host. Uses ONLY
onnxruntime + numpy + pillow + boto3 (NO torch); training runs in GitHub
Actions (services/cv-worker/train_cli.py), which also mints the calibration
data this function consumes.

Request (POST JSON):
  { "image_url": "<r2 key or public url>",
    "model_path": "cv/<projectId>/models/<version>.onnx",
    "confidence_threshold": 0.5,              // optional; also accepts legacy "threshold"
    "score_stats": {"rawMin": ..., "rawMax": ...} }   // optional, from calibration

Auth: header X-CV-Secret must equal env CV_WORKER_SECRET (when configured).
GET returns a health payload for smoke tests.

Response (JSON):
  { result, confidence, raw_score, normalized_score, anomaly_score,
    is_anomalous, threshold, processing_time_ms, defects }

Scoring contract (must match services/cv-worker/main.py /infer):
- raw_score is the model output untouched.
- With score_stats: normalized = clamp((raw - rawMin) / (rawMax - rawMin), 0, 1);
  degenerate range (rawMax <= rawMin) becomes a 0/1 step at rawMin. No sigmoid.
- Without score_stats: legacy behavior — sigmoid only when raw falls outside [0, 1].
- anomaly_score == normalized_score (back-compat field name).
"""

import hashlib
import json
import math
import os
import time
from http.server import BaseHTTPRequestHandler
from io import BytesIO

import boto3
import numpy as np
import onnxruntime as ort
from PIL import Image

R2_ACCOUNT_ID = os.environ.get("R2_ACCOUNT_ID", "")
R2_ACCESS_KEY_ID = os.environ.get("R2_ACCESS_KEY_ID", "")
R2_SECRET_ACCESS_KEY = os.environ.get("R2_SECRET_ACCESS_KEY", "")
R2_BUCKET_NAME = os.environ.get("R2_BUCKET_NAME", "brevitest-cv")
MODEL_INPUT_SIZE = int(os.environ.get("MODEL_INPUT_SIZE", "256"))
DEFAULT_THRESHOLD = float(os.environ.get("CONFIDENCE_THRESHOLD", "0.5"))
CV_WORKER_SECRET = os.environ.get("CV_WORKER_SECRET", "")

IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

# Warm-invocation caches (persist while the function instance is alive).
_session_cache: dict[str, ort.InferenceSession] = {}


def _s3():
    return boto3.client(
        "s3",
        endpoint_url=f"https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com",
        aws_access_key_id=R2_ACCESS_KEY_ID,
        aws_secret_access_key=R2_SECRET_ACCESS_KEY,
        region_name="auto",
    )


def _download(key: str) -> bytes:
    return _s3().get_object(Bucket=R2_BUCKET_NAME, Key=key)["Body"].read()


def _r2_key(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url.split("/", 3)[-1]
    return url


def _get_session(model_path: str) -> ort.InferenceSession:
    cached = _session_cache.get(model_path)
    if cached is not None:
        return cached
    # sha1 of the R2 key — replace('/', '_') can collide across distinct keys
    local = os.path.join("/tmp", hashlib.sha1(model_path.encode()).hexdigest() + ".onnx")
    if not os.path.exists(local):
        with open(local, "wb") as f:
            f.write(_download(model_path))
    session = ort.InferenceSession(local, providers=["CPUExecutionProvider"])
    _session_cache[model_path] = session
    return session


def _preprocess(data: bytes, size: int = MODEL_INPUT_SIZE) -> np.ndarray:
    img = Image.open(BytesIO(data)).convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    return arr.transpose(2, 0, 1)[np.newaxis]  # NCHW


def _normalize(raw: float, score_stats: dict | None) -> float:
    if score_stats is not None:
        raw_min = float(score_stats["rawMin"])
        raw_max = float(score_stats["rawMax"])
        denom = raw_max - raw_min
        if denom <= 0:  # degenerate calibration — 0/1 step at rawMin
            return 0.0 if raw <= raw_min else 1.0
        return min(max((raw - raw_min) / denom, 0.0), 1.0)
    # Legacy (uncalibrated): squash into 0..1 only when out of bounds.
    if raw < 0 or raw > 1:
        return 1.0 / (1.0 + math.exp(-raw))
    return raw


def run_inference(image_url: str, model_path: str, threshold: float, score_stats: dict | None) -> dict:
    start = time.time()
    image_data = _download(_r2_key(image_url))
    session = _get_session(model_path)

    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: _preprocess(image_data)})

    raw_score = float(np.asarray(outputs[0]).flatten()[0])
    normalized = _normalize(raw_score, score_stats)

    is_anomalous = normalized >= threshold
    confidence = normalized if is_anomalous else 1.0 - normalized
    return {
        "result": "fail" if is_anomalous else "pass",
        "confidence": round(confidence, 4),
        "raw_score": round(raw_score, 6),
        "normalized_score": round(normalized, 4),
        "anomaly_score": round(normalized, 4),  # back-compat alias
        "is_anomalous": is_anomalous,
        "threshold": round(threshold, 4),
        "processing_time_ms": round((time.time() - start) * 1000, 1),
        "defects": [{"type": "anomaly", "location": "global", "severity": "high"}]
        if is_anomalous
        else [],
    }


def _valid_score_stats(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    raw_min, raw_max = raw.get("rawMin"), raw.get("rawMax")
    if isinstance(raw_min, (int, float)) and isinstance(raw_max, (int, float)) \
            and math.isfinite(raw_min) and math.isfinite(raw_max):
        return {"rawMin": float(raw_min), "rawMax": float(raw_max)}
    return None


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):  # health probe for smoke tests
        self._send(200, {"status": "ok", "service": "bims-ml-infer", "auth": bool(CV_WORKER_SECRET)})

    def do_POST(self):
        try:
            if CV_WORKER_SECRET and self.headers.get("X-CV-Secret") != CV_WORKER_SECRET:
                return self._send(401, {"error": "Unauthorized"})

            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")

            image_url = req.get("image_url")
            model_path = req.get("model_path")
            if not image_url or not model_path:
                return self._send(400, {"error": "image_url and model_path are required"})

            threshold_in = req.get("confidence_threshold", req.get("threshold"))
            threshold = float(threshold_in) if isinstance(threshold_in, (int, float)) else DEFAULT_THRESHOLD
            score_stats = _valid_score_stats(req.get("score_stats"))

            self._send(200, run_inference(image_url, model_path, threshold, score_stats))
        except Exception as e:  # surface the error to the caller for debugging
            self._send(500, {"error": str(e)})
