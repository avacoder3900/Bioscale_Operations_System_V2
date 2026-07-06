"""One test shot: color + IR + N-frame median depth composite, saved to a viewable folder."""
import argparse
import json
import os

import numpy as np
import cv2
import pyrealsense2 as rs

parser = argparse.ArgumentParser()
parser.add_argument("--name", required=True)
parser.add_argument("--out-dir", default=r"C:\Users\aleja\Desktop\realsense-captures")
parser.add_argument("--disparity-shift", type=int, default=50)
parser.add_argument("--depth-units", type=int, default=100)
parser.add_argument("--laser-power", type=float, default=60)
parser.add_argument("--preset", choices=["default", "high_accuracy", "high_density"], default="default")
parser.add_argument("--frames", type=int, default=30)
parser.add_argument("--roi", default=None, help="x1,y1,x2,y2 in depth/IR coords for stats + crop")
parser.add_argument("--window", default=None, help="near_cm,far_cm color window override")
parser.add_argument("--width", type=int, default=1280)
parser.add_argument("--height", type=int, default=720)
parser.add_argument("--exposure", type=int, default=0, help="manual IR exposure in us (0 = auto)")
parser.add_argument("--gain", type=int, default=16)
args = parser.parse_args()
W, H = args.width, args.height

os.makedirs(args.out_dir, exist_ok=True)
out = lambda suffix: os.path.join(args.out_dir, f"{args.name}_{suffix}.png")

pipeline = rs.pipeline()
config = rs.config()
config.enable_stream(rs.stream.depth, W, H, rs.format.z16, 30)
config.enable_stream(rs.stream.color, 1280, 720, rs.format.bgr8, 30)
config.enable_stream(rs.stream.infrared, 1, W, H, rs.format.y8, 30)
profile = pipeline.start(config)
device = profile.get_device()

adv = rs.rs400_advanced_mode(device)
if not adv.is_enabled():
    adv.toggle_advanced_mode(True)

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
table = adv.get_depth_table()
table.disparityShift = args.disparity_shift
table.depthUnits = args.depth_units
adv.set_depth_table(table)

for _ in range(25):
    pipeline.wait_for_frames()

stack = np.full((args.frames, H, W), np.nan, dtype=np.float32)
color_img = ir_img = None
for i in range(args.frames):
    frames = pipeline.wait_for_frames()
    d = np.asanyarray(frames.get_depth_frame().get_data()).astype(np.float32)
    d[d == 0] = np.nan
    stack[i] = d
    if i == args.frames // 2:
        color_img = np.asanyarray(frames.get_color_frame().get_data()).copy()
        ir_img = np.asanyarray(frames.get_infrared_frame(1).get_data()).copy()
pipeline.stop()

comp = np.nanmedian(stack, axis=0)  # in depth units (0.1mm default)
comp_mm = comp * (args.depth_units / 1000.0)

if args.roi:
    x1, y1, x2, y2 = map(int, args.roi.split(","))
else:
    x1, y1, x2, y2 = 430, 300, 1140, 520
roi = comp_mm[y1:y2, x1:x2]
roi_valid = roi[~np.isnan(roi)]

valid_all = comp_mm[~np.isnan(comp_mm)]
if args.window:
    near_cm, far_cm = map(float, args.window.split(","))
    lo, hi = near_cm * 10, far_cm * 10
elif len(roi_valid):
    lo, hi = np.percentile(roi_valid, [2, 98])
    lo, hi = lo - 20, hi + 20
else:
    lo, hi = np.percentile(valid_all, [2, 98])

vis = np.clip((comp_mm - lo) / max(hi - lo, 1), 0, 1)
vis_u8 = np.nan_to_num(vis * 255, nan=0).astype(np.uint8)
colored = cv2.applyColorMap(255 - vis_u8, cv2.COLORMAP_TURBO)
colored[np.isnan(comp_mm)] = 0
cv2.rectangle(colored, (x1, y1), (x2, y2), (255, 255, 255), 2)

cv2.imwrite(out("1-color"), color_img)
cv2.imwrite(out("2-ir"), ir_img)
cv2.imwrite(out("3-depth"), colored)
crop = colored[y1:y2, x1:x2]
cv2.imwrite(out("4-depth-crop"), cv2.resize(crop, None, fx=2, fy=2, interpolation=cv2.INTER_NEAREST))
np.save(os.path.join(args.out_dir, f"{args.name}_depth_mm.npy"), comp_mm)

stats = {
    "name": args.name,
    "settings": {"preset": args.preset, "laser": args.laser_power,
                 "disparity_shift": args.disparity_shift, "depth_units_um": args.depth_units,
                 "frames_composited": args.frames},
    "roi_px": [x1, y1, x2, y2],
    "roi_fill_pct": round(100.0 * len(roi_valid) / roi.size, 1),
    "roi_median_cm": round(float(np.median(roi_valid)) / 10, 2) if len(roi_valid) else None,
    "roi_std_mm": round(float(np.std(roi_valid)), 2) if len(roi_valid) else None,
    "frame_fill_pct": round(100.0 * len(valid_all) / comp_mm.size, 1),
    "color_window_cm": [round(lo / 10, 1), round(hi / 10, 1)],
}
with open(os.path.join(args.out_dir, f"{args.name}_stats.json"), "w") as f:
    json.dump(stats, f, indent=2)
print(json.dumps(stats, indent=2))
