"""
Cartesian kinematics for the SO-100 follower arm.

Wraps the SO-100 URDF (`services/robot-arm/urdf/so100.urdf`) in an ikpy
Chain and exposes pose math in operator-friendly units (mm, deg).

Step↔radian conversion uses a per-joint calibration file at
~/.bims-arm/jog-calibration.json so the operator can dial in zero
offsets + axis signs without code edits. Schema:

    {
      "joints": {
        "1": {"zero_step": 2048, "sign": 1},
        "2": {"zero_step": 2048, "sign": 1},
        ...  (servo ids 1..5 — gripper id 6 is excluded from the position chain)
      },
      "axes_map": {"x": "x", "y": "y", "z": "z"},   // operator → URDF axis
      "axes_sign": {"x": 1, "y": 1, "z": 1}          // ±1 per axis
    }

Defaults: zero_step=2048 (midpoint of 0..4095), sign=+1, identity axes_map.
Calibration is read at boot and on every POST /jog/reload-calibration.

The 5-DoF chain (shoulder_pan, shoulder_lift, elbow_flex, wrist_flex,
wrist_roll) maps to servo ids 1..5 in joint order. Servo id 6 (gripper)
is open/close and not part of the kinematic chain.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
from typing import Optional

import ikpy.chain
import numpy as np

URDF_PATH = Path(__file__).resolve().parent.parent.parent / "urdf" / "so100.urdf"
CALIBRATION_PATH = Path(
    os.environ.get(
        "BIMS_ARM_JOG_CALIBRATION",
        str(Path.home() / ".bims-arm" / "jog-calibration.json"),
    )
)

# Servo ids 1..5 are the positioning chain; id 6 (gripper) is excluded.
JOG_SERVO_IDS = (1, 2, 3, 4, 5)

# STS3215 is a 4096-step-per-revolution encoder.
STEPS_PER_REV = 4096


def _default_calibration() -> dict:
    return {
        "joints": {str(sid): {"zero_step": 2048, "sign": 1} for sid in JOG_SERVO_IDS},
        "axes_map": {"x": "x", "y": "y", "z": "z"},
        "axes_sign": {"x": 1, "y": 1, "z": 1},
    }


class Kinematics:
    def __init__(self) -> None:
        # ikpy chain: 7 links — Base + 5 revolute + gripper. We only want
        # the 5 middle joints as "active" in IK (gripper doesn't affect
        # end-effector position, base is fixed).
        self.chain = ikpy.chain.Chain.from_urdf_file(
            str(URDF_PATH),
            base_elements=["base"],
            active_links_mask=[False, True, True, True, True, True, False],
        )
        self.calibration: dict = _default_calibration()
        self.calibration_source: str = "default (no file)"
        self.load_calibration()

    # --- calibration -----------------------------------------------------

    def load_calibration(self) -> str:
        if CALIBRATION_PATH.exists():
            try:
                raw = json.loads(CALIBRATION_PATH.read_text())
                cal = _default_calibration()
                # merge so partial files don't blow away unspecified fields
                cal["joints"].update({str(k): v for k, v in (raw.get("joints") or {}).items()})
                cal["axes_map"].update(raw.get("axes_map") or {})
                cal["axes_sign"].update(raw.get("axes_sign") or {})
                self.calibration = cal
                self.calibration_source = str(CALIBRATION_PATH)
            except Exception as exc:
                print(f"[kinematics] failed to load {CALIBRATION_PATH}: {exc}")
                self.calibration = _default_calibration()
                self.calibration_source = f"default (parse failed: {exc})"
        else:
            self.calibration = _default_calibration()
            self.calibration_source = "default (file absent)"
        return self.calibration_source

    # --- step ↔ radian ---------------------------------------------------

    def _joint_cal(self, sid: int) -> dict:
        return self.calibration["joints"].get(str(sid)) or {"zero_step": 2048, "sign": 1}

    def steps_to_rad(self, sid: int, steps: int) -> float:
        """Servo position (0..4095, with multi-turn for joint 5) → radians."""
        cal = self._joint_cal(sid)
        # Joint 5 (wrist_roll) is multi-turn; subtract zero and convert linearly.
        # Other joints: same formula, also valid in 0..4095 range.
        return float(cal["sign"]) * (steps - cal["zero_step"]) * (2.0 * math.pi / STEPS_PER_REV)

    def rad_to_steps(self, sid: int, rad: float) -> int:
        cal = self._joint_cal(sid)
        return int(round(cal["zero_step"] + float(cal["sign"]) * rad * STEPS_PER_REV / (2.0 * math.pi)))

    # --- xyz ↔ ikpy frame ------------------------------------------------

    def operator_to_urdf(self, dx: float, dy: float, dz: float) -> tuple[float, float, float]:
        """Apply operator→URDF axis remapping + signs to a delta vector."""
        axes_map = self.calibration["axes_map"]
        axes_sign = self.calibration["axes_sign"]
        urdf_vec = {"x": 0.0, "y": 0.0, "z": 0.0}
        for op_axis, op_delta in [("x", dx), ("y", dy), ("z", dz)]:
            target = axes_map.get(op_axis, op_axis)
            urdf_vec[target] += float(axes_sign.get(op_axis, 1)) * op_delta
        return urdf_vec["x"], urdf_vec["y"], urdf_vec["z"]

    def urdf_to_operator(self, x: float, y: float, z: float) -> tuple[float, float, float]:
        """Inverse of operator_to_urdf — used for reporting current pose to the operator."""
        axes_map = self.calibration["axes_map"]
        axes_sign = self.calibration["axes_sign"]
        urdf = {"x": x, "y": y, "z": z}
        op_vec = {"x": 0.0, "y": 0.0, "z": 0.0}
        for op_axis in ("x", "y", "z"):
            target = axes_map.get(op_axis, op_axis)
            op_vec[op_axis] = float(axes_sign.get(op_axis, 1)) * urdf[target]
        return op_vec["x"], op_vec["y"], op_vec["z"]

    # --- FK / IK ---------------------------------------------------------

    def _angles_vector(self, joint_steps: dict[int, int]) -> list[float]:
        """Build the 7-length angle vector ikpy needs from servo positions."""
        # ikpy expects [base, j1, j2, j3, j4, j5, gripper] — base + gripper are
        # inactive (fixed at 0); the middle 5 are the active chain.
        vec = [0.0]
        for sid in JOG_SERVO_IDS:
            steps = joint_steps.get(sid)
            if steps is None:
                raise ValueError(f"fk needs position for servo {sid}")
            vec.append(self.steps_to_rad(sid, steps))
        vec.append(0.0)  # gripper position not used for end-effector pose
        return vec

    def fk(self, joint_steps: dict[int, int]) -> dict:
        """End-effector pose in operator-friendly units (mm)."""
        vec = self._angles_vector(joint_steps)
        mat = self.chain.forward_kinematics(vec)
        x_urdf, y_urdf, z_urdf = mat[:3, 3]
        x_op, y_op, z_op = self.urdf_to_operator(float(x_urdf), float(y_urdf), float(z_urdf))
        return {
            "x_mm": round(x_op * 1000.0, 2),
            "y_mm": round(y_op * 1000.0, 2),
            "z_mm": round(z_op * 1000.0, 2),
            "joint_angles_deg": {
                sid: round(math.degrees(self.steps_to_rad(sid, joint_steps[sid])), 2)
                for sid in JOG_SERVO_IDS
            },
            "joint_steps": dict(joint_steps),
        }

    def ik_for_delta(
        self,
        current_steps: dict[int, int],
        dx_mm: float,
        dy_mm: float,
        dz_mm: float,
    ) -> dict[int, int]:
        """Compute new servo steps that move the end-effector by (dx,dy,dz) mm.

        Uses the current pose as the seed so IK stays near the current arm
        configuration (avoids elbow-flip jumps).
        """
        # Current end-effector in URDF coords
        seed = self._angles_vector(current_steps)
        current_mat = self.chain.forward_kinematics(seed)
        current_xyz = current_mat[:3, 3]
        # Operator delta → URDF delta
        du, dv, dw = self.operator_to_urdf(dx_mm / 1000.0, dy_mm / 1000.0, dz_mm / 1000.0)
        target = current_xyz + np.array([du, dv, dw], dtype=float)
        ik_angles = self.chain.inverse_kinematics(target, initial_position=seed)
        # Pluck out the 5 active joints
        out: dict[int, int] = {}
        for i, sid in enumerate(JOG_SERVO_IDS, start=1):
            out[sid] = self.rad_to_steps(sid, float(ik_angles[i]))
        return out


# Lazy singleton — server.app imports this once and reuses.
_singleton: Optional[Kinematics] = None


def get_kinematics() -> Kinematics:
    global _singleton
    if _singleton is None:
        _singleton = Kinematics()
    return _singleton
