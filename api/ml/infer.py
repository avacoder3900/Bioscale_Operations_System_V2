"""
Vercel Python serverless function: ONNX cartridge inference.

This is the "always online" half of the BIMS CV pipeline. It lives in the SAME
Vercel project as the SvelteKit app, so it deploys with every push and is reached
at /api/ml/infer on the same domain — no separate host, no CV_WORKER_URL pointing
elsewhere. It uses ONLY onnxruntime + numpy + pillow + boto3 (NO torch), which
keeps it well under Vercel's function size limit. Training (which needs torch)
runs in GitHub Actions, not here.

Request (POST JSON):
  { "image_url": "<r2 key or public url>",
    "model_path": "cv/<projectId>/models/model.onnx",
    "threshold": 0.5 }
Auth: header x-ml-secret must equal env ML_INFER_SECRET (when configured).

Response (JSON):
  { result, confidence, anomaly_score, is_anomalous, processing_time_ms, defects }
"""

import json
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
ML_INFER_SECRET = os.environ.get("ML_INFER_SECRET", "")

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
    local = os.path.join("/tmp", model_path.replace("/", "_"))
    if not os.path.exists(local):
        os.makedirs(os.path.dirname(local), exist_ok=True)
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


def run_inference(image_url: str, model_path: str, threshold: float) -> dict:
    start = time.time()
    image_data = _download(_r2_key(image_url))
    session = _get_session(model_path)

    input_name = session.get_inputs()[0].name
    outputs = session.run(None, {input_name: _preprocess(image_data)})

    anomaly_score = float(np.asarray(outputs[0]).flatten()[0])
    if anomaly_score < 0 or anomaly_score > 1:  # squash logits into 0..1
        anomaly_score = 1.0 / (1.0 + np.exp(-anomaly_score))

    is_anomalous = anomaly_score >= threshold
    confidence = anomaly_score if is_anomalous else 1.0 - anomaly_score
    return {
        "result": "fail" if is_anomalous else "pass",
        "confidence": round(confidence, 4),
        "anomaly_score": round(anomaly_score, 4),
        "is_anomalous": is_anomalous,
        "processing_time_ms": round((time.time() - start) * 1000, 1),
        "defects": [{"type": "anomaly", "location": "global", "severity": "high"}]
        if is_anomalous
        else [],
    }


class handler(BaseHTTPRequestHandler):
    def _send(self, status: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        try:
            if ML_INFER_SECRET and self.headers.get("x-ml-secret") != ML_INFER_SECRET:
                return self._send(401, {"error": "Unauthorized"})

            length = int(self.headers.get("Content-Length", 0))
            req = json.loads(self.rfile.read(length) or b"{}")

            image_url = req.get("image_url")
            model_path = req.get("model_path")
            if not image_url or not model_path:
                return self._send(400, {"error": "image_url and model_path are required"})

            threshold = float(req.get("threshold", DEFAULT_THRESHOLD))
            self._send(200, run_inference(image_url, model_path, threshold))
        except Exception as e:  # surface the error to the caller for debugging
            self._send(500, {"error": str(e)})
