"""
Recording export / delete / restore for the robot-arm service.

BIMS owns the 30-day trash: before deleting it pulls both files through
/export and stores them in R2, and only then calls DELETE. Recover pushes the
files back through /restore. The Pi keeps no trash of its own, so a dead SD
card cannot take the recovery copies with it.

Endpoints (auth is applied by app.py when the router is included):
    GET    /recordings/{name}/export   {name, jsonl, meta}
    DELETE /recordings/{name}          {deleted: name}
    POST   /recordings/restore         {name, jsonl, meta, replace?} -> {restored, replaced, path}

Rules:
  * Names must resolve to a file directly inside RECORDINGS_DIR; anything with a
    path separator or a leading dot is rejected.
  * DELETE refuses (409) while any session is active, since a replay may be
    reading the file. The session probe is wired from app.py by bind(state)
    (an object with .active_session) or bind_sessions(sessions) (the live Pi's
    SessionManager, whose .active() is a dict or None); if neither was bound
    the check is skipped rather than blocking every delete.
  * RESTORE refuses (409) to overwrite an existing recording, unless the body
    says replace: true (2026-11-05, BIMS's Animate scratch path: one call
    instead of DELETE + restore). A replace is refused (409) while a session is
    active, like DELETE. The file is written to a temp name and renamed, so a
    reader never sees half a file. The reply carries the recording's path the
    way GET /recordings lists it, so BIMS can start the replay without listing.
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
_sessions: Any = None


def bind(state: Any) -> None:
    """Give the router app.py's state object so DELETE can see active sessions."""
    global _state
    _state = state


def bind_sessions(sessions: Any) -> None:
    """Give the router the live Pi's SessionManager (`sessions = SessionManager(...)` in app.py)."""
    global _sessions
    _sessions = sessions


def _session_active() -> Optional[str]:
    if _sessions is not None:
        try:
            active = _sessions.active()
        except Exception:
            active = None
        if active:
            return str(active.get("kind", "unknown")) if isinstance(active, dict) else "unknown"
    sess = getattr(_state, "active_session", None) if _state is not None else None
    try:
        if sess is not None and sess.is_active():
            return getattr(sess, "kind", "unknown")
    except Exception:
        return None
    return None


def _listed_path(jsonl: Path) -> str:
    """The path as GET /recordings lists it (relative to the service's working dir, e.g. datasets/x.jsonl)."""
    try:
        return str(jsonl.relative_to(Path.cwd().resolve()))
    except ValueError:
        return str(jsonl)


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
    replace: bool = False


def _write_atomic(target: Path, text: str) -> None:
    tmp = target.with_name(f".{target.name}.tmp")
    tmp.write_text(text)
    os.replace(tmp, target)


@router.post("/recordings/restore")
async def restore_recording(req: RestoreRequest) -> dict:
    jsonl, meta = _paths(req.name)
    existed = jsonl.exists()
    if existed and not req.replace:
        raise HTTPException(status_code=409, detail=f"a recording named '{req.name}' already exists")
    if existed:
        kind = _session_active()
        if kind is not None:
            raise HTTPException(
                status_code=409, detail=f"a {kind} session is active — stop it before replacing recordings"
            )
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    _write_atomic(jsonl, req.jsonl)
    if req.meta is not None:
        _write_atomic(meta, json.dumps(req.meta, indent=2))
    elif existed and meta.exists():
        meta.unlink()
    return {"restored": jsonl.stem, "replaced": existed, "path": _listed_path(jsonl)}
