"""
JSONL recording I/O for leader-follower teleop captures.

Each recording is TWO files in ~/.bims-arm/recordings/:
  <name>.jsonl       — one frame per line: {"t": seconds, "positions": {sid: pos}}
  <name>.meta.json   — provenance sidecar (written when meta is supplied):
                       {schema_version, lot_id, manufacturing_step,
                        recorded_during_run_id, operator, started_at_iso,
                        rate_hz, frame_count}

The sidecar is optional — legacy recordings without one keep working
(meta surfaces as None). Sidecar JSON deliberately mirrors the start
webhook event's extras so a recording on disk and the matching
RobotArmRun in BIMS can be cross-referenced by lot.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Optional

RECORDINGS_DIR = Path(
    os.environ.get("BIMS_ARM_RECORDINGS_DIR", str(Path.home() / ".bims-arm" / "recordings"))
)

RECORDING_SCHEMA_VERSION = 1

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(name: str) -> str:
    return _SAFE_NAME_RE.sub("-", name.strip()) or "unnamed"


def recording_path(name: str) -> Path:
    return RECORDINGS_DIR / f"{_safe_name(name)}.jsonl"


def meta_path(name: str) -> Path:
    return RECORDINGS_DIR / f"{_safe_name(name)}.meta.json"


def save_recording(
    name: str,
    frames: list[dict],
    meta: Optional[dict] = None,
) -> Path:
    """Write the JSONL frame stream and (if provided) the meta sidecar.

    Meta is enriched with schema_version + frame_count before writing so
    callers don't have to remember to set them.
    """
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    path = recording_path(name)
    with path.open("w") as fh:
        for frame in frames:
            fh.write(json.dumps(frame, separators=(",", ":")) + "\n")
    if meta is not None:
        sidecar = {
            "schema_version": RECORDING_SCHEMA_VERSION,
            "frame_count": len(frames),
            **{k: v for k, v in meta.items() if v is not None},
        }
        meta_path(name).write_text(json.dumps(sidecar, indent=2))
    return path


def load_recording(source: str) -> list[dict]:
    """Resolve `source` (bare name, file basename, or absolute path) to a frame list."""
    candidates: list[Path] = []
    p = Path(source)
    if p.is_absolute():
        candidates.append(p)
    else:
        candidates.append(RECORDINGS_DIR / source)
        candidates.append(RECORDINGS_DIR / f"{source}.jsonl")
        candidates.append(recording_path(source))
    for c in candidates:
        if c.exists():
            with c.open() as fh:
                return [json.loads(line) for line in fh if line.strip()]
    raise FileNotFoundError(f"recording not found: {source}")


def load_meta(name: str) -> Optional[dict]:
    """Read the sidecar meta for `name`. Returns None if absent or unparseable."""
    p = meta_path(name)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text())
    except Exception:
        return None


def list_recordings() -> list[dict]:
    if not RECORDINGS_DIR.exists():
        return []
    out: list[dict] = []
    for f in sorted(RECORDINGS_DIR.glob("*.jsonl"), key=lambda p: -p.stat().st_mtime):
        stat = f.stat()
        out.append(
            {
                "name": f.stem,
                "path": str(f),
                "size_bytes": stat.st_size,
                "modified": stat.st_mtime,
                "meta": load_meta(f.stem),
            }
        )
    return out


def delete_recording(name: str) -> bool:
    """Remove the JSONL and its meta sidecar (if present). Returns True if either existed."""
    path = recording_path(name)
    meta = meta_path(name)
    existed = False
    if path.exists():
        path.unlink()
        existed = True
    if meta.exists():
        meta.unlink()
        existed = True
    return existed
