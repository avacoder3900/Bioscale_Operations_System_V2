"""Fuse median composites captured at multiple disparity shifts into one depth map."""
import json
import os

import numpy as np
import cv2
import pyrealsense2 as rs

OUT_DIR = r"C:\Users\aleja\Desktop\realsense-captures"
NAME = "test24-fused-clean"
SHIFTS = [100, 200, 320]
N_FRAMES = 30
SETTLE = 20
WINDOW_CM = (12, 30)

pipeline = rs.pipeline()
config = rs.config()
config.enable_stream(rs.stream.depth, 1280, 720, rs.format.z16, 30)
config.enable_stream(rs.stream.color, 1280, 720, rs.format.bgr8, 30)
profile = pipeline.start(config)
device = profile.get_device()

adv = rs.rs400_advanced_mode(device)
if not adv.is_enabled():
    adv.toggle_advanced_mode(True)
depth_sensor = device.first_depth_sensor()
depth_sensor.set_option(rs.option.visual_preset, 1)
depth_sensor.set_option(rs.option.laser_power, 60)
depth_sensor.set_option(rs.option.enable_auto_exposure, 1)

color_img = None
layers = []
for shift in SHIFTS:
    table = adv.get_depth_table()
    table.disparityShift = shift
    table.depthUnits = 100
    adv.set_depth_table(table)
    for _ in range(SETTLE):
        pipeline.wait_for_frames()
    stack = np.full((N_FRAMES, 720, 1280), np.nan, dtype=np.float32)
    for i in range(N_FRAMES):
        frames = pipeline.wait_for_frames()
        d = np.asanyarray(frames.get_depth_frame().get_data()).astype(np.float32)
        d[d == 0] = np.nan
        stack[i] = d
        if color_img is None:
            color_img = np.asanyarray(frames.get_color_frame().get_data()).copy()
    comp_mm = np.nanmedian(stack, axis=0) / 10.0  # -> mm
    fill = 100.0 * (~np.isnan(comp_mm)).sum() / comp_mm.size
    print(f"shift {shift}: fill {fill:.1f}%")
    layers.append(comp_mm)
pipeline.stop()

stack3 = np.stack(layers)
count = (~np.isnan(stack3)).sum(axis=0)
spread = np.nanmax(stack3, axis=0) - np.nanmin(stack3, axis=0)
fused = np.nanmedian(stack3, axis=0)
# keep single-window pixels, and multi-window pixels only when windows agree within 4mm
fused[(count >= 2) & (spread > 4.0)] = np.nan
fill = 100.0 * (~np.isnan(fused)).sum() / fused.size
valid = fused[~np.isnan(fused)]

lo, hi = WINDOW_CM[0] * 10, WINDOW_CM[1] * 10
vis = np.clip((fused - lo) / (hi - lo), 0, 1)
vis_u8 = np.nan_to_num(vis * 255, nan=0).astype(np.uint8)
colored = cv2.applyColorMap(255 - vis_u8, cv2.COLORMAP_TURBO)
colored[np.isnan(fused)] = 0

cv2.imwrite(os.path.join(OUT_DIR, f"{NAME}_1-color.png"), color_img)
cv2.imwrite(os.path.join(OUT_DIR, f"{NAME}_3-depth.png"), colored)
np.save(os.path.join(OUT_DIR, f"{NAME}_depth_mm.npy"), fused)

print(json.dumps({
    "name": NAME,
    "shifts_fused": SHIFTS,
    "frame_fill_pct": round(fill, 1),
    "median_cm": round(float(np.median(valid)) / 10, 2),
    "min_cm": round(float(valid.min()) / 10, 2),
    "max_cm": round(float(valid.max()) / 10, 2),
}, indent=2))
