"""
Recording export / delete / restore for the robot-arm service.

BIMS owns the 30-day trash: before deleting it pulls both files through
/export and stores them in R2, and only then calls DELETE. Recover pushes the
files back through /restore. The Pi keeps no trash of its own, so a dead SD
card cannot take the recovery copies with it.

Endpoints (auth is applied by app.py when the router is included):
    GET    /recordings/{name}/export   {name, jsonl, meta}
    DELETE /recordings/{name}          {deleted: name}
    POST   /recordings/restore         {name, jsonl, meta} -> {restored: name}

Rules:
  * Names must resolve to a file directly inside RECORDINGS_DIR; anything with a
    path separator or a leading dot is rejected.
  * DELETE refuses (409) while any session is active, since a replay may be
    reading the file. The session probe is wired by bind(state) from app.py; if
    it was never bound the check is skipped rather than blocking every delete.
  * RESTORE refuses (409) to overwrite an existing recording.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

try:
    from arm.recordings import RECORDINGS_DIR
except Exception:  # pragma: no cover - mirrors arm/recordings.py's default
    RECORDINGS_DIR = Path(
        os.environ.get("BIMS_ARM_RECORDINGS_DIR", str(Path.home() / ".bims-arm" / "recordings"))
    )

router = APIRouter()

_state: Any = None


def bind(state: Any) -> None:
    """Give the router app.py's state object so DELETE can see active sessions."""
    global _state
    _state = state


def _session_active() -> Optional[str]:
    sess = getattr(_state, "active_session", None) if _state is not None else None
    try:
        if sess is not None and sess.is_active():
            return getattr(sess, "kind", "unknown")
    except Exception:
        return None
    return None


def _paths(name: str) -> tuple[Path, Path]:
    # The live Pi lists recordings by file name; accept "x.jsonl" as well as "x".
    if name.lower().endswith(".jsonl"):
        name = name[: -len(".jsonl")]
    if not name or name.startswith(".") or "/" in name or "\\" in name or "\x00" in name:
        raise HTTPException(status_code=400, detail=f"invalid recording name: {name!r}")
    base = RECORDINGS_DIR.resolve()
    jsonl = (RECORDINGS_DIR / f"{name}.jsonl").resolve()
    meta = (RECORDINGS_DIR / f"{name}.meta.json").resolve()
    if jsonl.parent != base or meta.parent != base:
        raise HTTPException(status_code=400, detail=f"invalid recording name: {name!r}")
    return jsonl, meta


def _read_meta(meta: Path) -> Optional[dict]:
    if not meta.exists():
        return None
    try:
        return json.loads(meta.read_text())
    except Exception:
        return None


@router.get("/recordings/{name}/export")
async def export_recording(name: str) -> dict:
    jsonl, meta = _paths(name)
    if not jsonl.exists():
        raise HTTPException(status_code=404, detail=f"recording not found: {name}")
    return {"name": name, "jsonl": jsonl.read_text(), "meta": _read_meta(meta)}


@router.delete("/recordings/{name}")
async def delete_recording(name: str) -> dict:
    jsonl, meta = _paths(name)
    kind = _session_active()
    if kind is not None:
        raise HTTPException(
            status_code=409, detail=f"a {kind} session is active — stop it before deleting recordings"
        )
    if not jsonl.exists():
        raise HTTPException(status_code=404, detail=f"recording not found: {name}")
    jsonl.unlink()
    if meta.exists():
        meta.unlink()
    return {"deleted": name}


class RestoreRequest(BaseModel):
    name: str
    jsonl: str
    meta: Optional[dict] = None


@router.post("/recordings/restore")
async def restore_recording(req: RestoreRequest) -> dict:
    jsonl, meta = _paths(req.name)
    if jsonl.exists():
        raise HTTPException(status_code=409, detail=f"a recording named '{req.name}' already exists")
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    jsonl.write_text(req.jsonl)
    if req.meta is not None:
        meta.write_text(json.dumps(req.meta, indent=2))
    return {"restored": req.name}
