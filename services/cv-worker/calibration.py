"""
Shared post-training calibration for the BIMS CV pipeline.

Used by BOTH training paths — the long-lived worker's /train background task
(main.py) and the one-shot CI trainer (train_cli.py) — so the threshold math
can never drift between them.

After PaDiM training + ONNX export, this module scores EVERY labeled image
(good + bad) with the exported ONNX model (same preprocessing as the worker's
/infer path), records min-max normalization params over the raw scores, sweeps
candidate thresholds over the normalized scores, and picks the F1-optimal one.
A labeled-bad image detected as anomalous (normalized score >= threshold)
counts as a true positive.

Result shape (matches the trainedModels[] contract on the app side):
    {
        "calibratedThreshold": float | None,   # in normalized [0, 1] space
        "scoreStats": {"rawMin", "rawMax", "goodMean", "badMean"},
        "metrics": {"f1", "threshold", "falsePassRate", "falseFailRate",
                    "nGood", "nBad"},
        "calibrationWarning": str | None,
    }
"""

import math
from io import BytesIO
from pathlib import Path
from typing import Callable, Sequence, Union

import numpy as np

# Same constants as the /infer preprocessing (single source of truth lives here;
# main.py imports preprocess_image from this module).
IMAGENET_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
IMAGENET_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)

ImageInput = Union[bytes, str, Path]


def sanitize_for_json(value):
    """Recursively replace non-finite floats (NaN/Inf) with None so payloads
    built from model outputs always serialize to strict JSON (json.dumps would
    otherwise emit the literal token NaN, which no JSON parser accepts)."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: sanitize_for_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize_for_json(v) for v in value]
    return value


def preprocess_image(data: bytes, size: int = 256) -> np.ndarray:
    """Identical preprocessing to the worker's /infer path (iCast lineage)."""
    from PIL import Image

    img = Image.open(BytesIO(data)).convert("RGB").resize((size, size), Image.BILINEAR)
    arr = np.array(img, dtype=np.float32) / 255.0
    arr = (arr - IMAGENET_MEAN) / IMAGENET_STD
    return arr.transpose(2, 0, 1)[np.newaxis]  # NCHW


def make_onnx_scorer(onnx_path: Union[str, Path], input_size: int = 256) -> Callable[[ImageInput], float]:
    """Build a scoring function over the exported ONNX model.

    Scores exactly like /infer: preprocess -> session.run -> first output
    flattened, element 0, as a raw (unnormalized) anomaly score.
    """
    import onnxruntime as ort  # lazy: keeps module import light for the CLI

    session = ort.InferenceSession(str(onnx_path), providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name

    def score(item: ImageInput) -> float:
        data = item if isinstance(item, bytes) else Path(item).read_bytes()
        outputs = session.run(None, {input_name: preprocess_image(data, input_size)})
        return float(outputs[0].flatten()[0])

    return score


def _normalize(score: float, raw_min: float, raw_max: float) -> float:
    denom = raw_max - raw_min
    if denom <= 0:
        return 0.0 if score <= raw_min else 1.0
    return min(max((score - raw_min) / denom, 0.0), 1.0)


def calibrate(
    score_fn: Callable[[ImageInput], float],
    good_items: Sequence[ImageInput],
    bad_items: Sequence[ImageInput],
) -> dict:
    """Score every labeled image, derive scoreStats, sweep for the F1-optimal
    threshold over normalized scores. See module docstring for the result shape.
    """
    good_scores = [float(score_fn(item)) for item in good_items]
    bad_scores = [float(score_fn(item)) for item in bad_items]

    if not good_scores:
        raise ValueError("calibration requires at least one labeled-good image")

    # Guard against NaN/Inf raw scores (plausible from a degenerate PaDiM fit,
    # e.g. singular covariance on the 5-image minimum). One NaN would silently
    # poison scoreStats and the threshold sweep (NaN comparisons are all False),
    # and a NaN calibratedThreshold corrupts every downstream JSON consumer.
    # Both callers catch this and fall back to the explicit
    # {calibratedThreshold: None, calibrationWarning: 'calibration failed: ...'}
    # shape, which serializes cleanly.
    n_bad_scores = sum(1 for s in good_scores + bad_scores if not math.isfinite(s))
    if n_bad_scores:
        raise ValueError(
            f"{n_bad_scores} of {len(good_scores) + len(bad_scores)} raw scores are "
            "non-finite (NaN/Inf) — the trained model is degenerate; refusing to calibrate"
        )

    all_scores = good_scores + bad_scores
    raw_min = float(min(all_scores))
    raw_max = float(max(all_scores))
    score_stats = {
        "rawMin": raw_min,
        "rawMax": raw_max,
        "goodMean": float(np.mean(good_scores)),
        "badMean": float(np.mean(bad_scores)) if bad_scores else None,
    }
    n_good = len(good_scores)
    n_bad = len(bad_scores)

    def _uncalibrated(warning: str) -> dict:
        return {
            "calibratedThreshold": None,
            "scoreStats": score_stats,
            "metrics": {
                "f1": None,
                "threshold": None,
                "falsePassRate": None,
                "falseFailRate": None,
                "nGood": n_good,
                "nBad": n_bad,
            },
            "calibrationWarning": warning,
        }

    if n_bad == 0:
        return _uncalibrated("no labeled-bad images")

    if raw_max - raw_min <= 0:
        return _uncalibrated("degenerate score range (all images scored identically)")

    norm_good = [_normalize(s, raw_min, raw_max) for s in good_scores]
    norm_bad = [_normalize(s, raw_min, raw_max) for s in bad_scores]

    # Candidate thresholds: midpoints between adjacent sorted unique scores.
    # raw_max > raw_min guarantees at least two unique values, so >= 1 candidate.
    uniq = sorted(set(norm_good + norm_bad))
    candidates = [(uniq[i] + uniq[i + 1]) / 2.0 for i in range(len(uniq) - 1)]

    best = None  # (f1, threshold, false_pass, false_fail)
    for t in candidates:
        tp = sum(1 for s in norm_bad if s >= t)   # bad correctly flagged anomalous
        fn = n_bad - tp                            # bad that slipped through (false pass)
        fp = sum(1 for s in norm_good if s >= t)   # good wrongly flagged (false fail)
        f1 = (2 * tp) / (2 * tp + fp + fn) if (2 * tp + fp + fn) > 0 else 0.0
        # Ties broken toward the higher threshold (fewer false fails for operators).
        if best is None or f1 > best[0] or (f1 == best[0] and t > best[1]):
            best = (f1, t, fn / n_bad, fp / n_good)

    f1, threshold, false_pass_rate, false_fail_rate = best
    return {
        "calibratedThreshold": threshold,
        "scoreStats": score_stats,
        "metrics": {
            "f1": f1,
            "threshold": threshold,
            "falsePassRate": false_pass_rate,
            "falseFailRate": false_fail_rate,
            "nGood": n_good,
            "nBad": n_bad,
        },
        "calibrationWarning": None,
    }
