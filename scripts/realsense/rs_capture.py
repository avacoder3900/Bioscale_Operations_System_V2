"""Capture a depth + color frame from the D415 with tunable close-range settings."""
import argparse
import json
import os
import sys

import numpy as np
import cv2
import pyrealsense2 as rs

parser = argparse.ArgumentParser()
parser.add_argument("--disparity-shift", type=int, default=0)
parser.add_argument("--depth-units", type=int, default=1000, help="micrometers per depth unit")
parser.add_argument("--laser-power", type=float, default=150)
parser.add_argument("--preset", choices=["default", "high_accuracy", "high_density"], default="default")
parser.add_argument("--warmup", type=int, default=30, help="frames to discard for auto-exposure settle")
parser.add_argument("--exposure", type=int, default=0, help="manual IR exposure in us (0 = auto)")
parser.add_argument("--gain", type=int, default=16)
parser.add_argument("--out", default="capture")
args = parser.parse_args()

pipeline = rs.pipeline()
config = rs.config()
config.enable_stream(rs.stream.depth, 1280, 720, rs.format.z16, 30)
config.enable_stream(rs.stream.color, 1280, 720, rs.format.bgr8, 30)
config.enable_stream(rs.stream.infrared, 1, 1280, 720, rs.format.y8, 30)

profile = pipeline.start(config)
device = profile.get_device()

# Advanced mode: disparity shift + depth units
adv = rs.rs400_advanced_mode(device)
if not adv.is_enabled():
    adv.toggle_advanced_mode(True)
table = adv.get_depth_table()
table.disparityShift = args.disparity_shift
table.depthUnits = args.depth_units
adv.set_depth_table(table)

depth_sensor = device.first_depth_sensor()
presets = {"default": 1, "high_accuracy": 3, "high_density": 4}
depth_sensor.set_option(rs.option.visual_preset, presets[args.preset])
depth_sensor.set_option(rs.option.laser_power, args.laser_power)
if args.exposure > 0:
    depth_sensor.set_option(rs.option.enable_auto_exposure, 0)
    depth_sensor.set_option(rs.option.exposure, args.exposure)
    depth_sensor.set_option(rs.option.gain, args.gain)
else:
    depth_sensor.set_option(rs.option.enable_auto_exposure, 1)

# NOTE: preset may override depth table; re-apply after preset
adv.set_depth_table(table)

align = rs.align(rs.stream.color)
temporal = rs.temporal_filter()
spatial = rs.spatial_filter()

for _ in range(args.warmup):
    frames = pipeline.wait_for_frames()

raw_frames = pipeline.wait_for_frames()
ir_frame = raw_frames.get_infrared_frame(1)
ir_img = np.asanyarray(ir_frame.get_data()).copy()
frames = align.process(raw_frames)
depth_frame = frames.get_depth_frame()
color_frame = frames.get_color_frame()
depth_frame = spatial.process(temporal.process(depth_frame)).as_depth_frame()

scale = depth_sensor.get_depth_scale()  # meters per unit
depth_raw = np.asanyarray(depth_frame.get_data())
depth_m = depth_raw.astype(np.float32) * scale
color_img = np.asanyarray(color_frame.get_data())

# Colorize depth for viewing
colorizer = rs.colorizer()
depth_color = np.asanyarray(colorizer.colorize(depth_frame).get_data())

cv2.imwrite(f"{args.out}_color.png", color_img)
cv2.imwrite(f"{args.out}_ir.png", ir_img)
sat_pct = round(100.0 * (ir_img >= 250).sum() / ir_img.size, 1)
cv2.imwrite(f"{args.out}_depth.png", cv2.cvtColor(depth_color, cv2.COLOR_RGB2BGR))

valid = depth_m > 0
h, w = depth_m.shape
cy, cx = h // 2, w // 2
roi = depth_m[cy - 100:cy + 100, cx - 100:cx + 100]
roi_valid = roi[roi > 0]

stats = {
    "settings": {
        "disparity_shift": args.disparity_shift,
        "depth_units_um": args.depth_units,
        "laser_power": args.laser_power,
        "preset": args.preset,
        "depth_scale_m": scale,
    },
    "fill_rate_pct": round(100.0 * valid.sum() / valid.size, 1),
    "center_roi": {
        "fill_pct": round(100.0 * len(roi_valid) / roi.size, 1),
        "median_cm": round(float(np.median(roi_valid)) * 100, 2) if len(roi_valid) else None,
        "min_cm": round(float(roi_valid.min()) * 100, 2) if len(roi_valid) else None,
        "max_cm": round(float(roi_valid.max()) * 100, 2) if len(roi_valid) else None,
        "std_mm": round(float(np.std(roi_valid)) * 1000, 2) if len(roi_valid) else None,
    },
    "scene_min_cm": round(float(depth_m[valid].min()) * 100, 2) if valid.any() else None,
    "ir_saturated_pct": sat_pct,
    "ir_mean_brightness": round(float(ir_img.mean()), 1),
}
print(json.dumps(stats, indent=2))

pipeline.stop()
