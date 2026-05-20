"""
JSONL recording I/O for leader-follower teleop captures.

Recordings live in ~/.bims-arm/recordings/<name>.jsonl. Each line is a
single frame: {"t": float-seconds-since-start, "positions": {sid: pos}}.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

RECORDINGS_DIR = Path(
    os.environ.get("BIMS_ARM_RECORDINGS_DIR", str(Path.home() / ".bims-arm" / "recordings"))
)

_SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._-]+")


def _safe_name(name: str) -> str:
    return _SAFE_NAME_RE.sub("-", name.strip()) or "unnamed"


def recording_path(name: str) -> Path:
    return RECORDINGS_DIR / f"{_safe_name(name)}.jsonl"


def save_recording(name: str, frames: list[dict]) -> Path:
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    path = recording_path(name)
    with path.open("w") as fh:
        for frame in frames:
            fh.write(json.dumps(frame, separators=(",", ":")) + "\n")
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
            }
        )
    return out


def delete_recording(name: str) -> bool:
    path = recording_path(name)
    if path.exists():
        path.unlink()
        return True
    return False
