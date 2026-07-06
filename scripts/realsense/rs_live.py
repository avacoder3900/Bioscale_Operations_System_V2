"""D415 live tuner — overview | color zoom | depth zoom, with keyboard controls.

Keys:
  z / x : disparity shift -20 / +20        (depth)
  c / v : laser power -30 / +30, 0 = off   (depth; also kills purple in color)
  j / k : color sharpness -10 / +10
  e     : toggle color auto-exposure
  d / f : color exposure -/+ (manual mode)
  g / h : color gain -/+ (manual mode)
  - / + : zoom out / in
  arrows: pan the zoom region
  s     : save snapshot PNGs to the captures folder
  p     : premium shot — average 30 frames, save max-quality PNG
  q     : quit

Status bar shows a live FOCUS score (sharpness of the zoom region).
Raise/lower the camera until it peaks — that height is max real detail.
"""
import os
import time

import numpy as np
import cv2
import pyrealsense2 as rs

OUT_DIR = r"C:\Users\aleja\Desktop\realsense-captures"
PANEL = (480, 270)  # w, h of each panel
DEPTH_WIN_MM = (105, 160)  # tight window around a ~120mm working plane

shift = 320
laser = 60
zoom = 3.0
cx, cy = 0.5, 0.5  # zoom center, relative

pipeline = rs.pipeline()
config = rs.config()
config.enable_stream(rs.stream.depth, 1280, 720, rs.format.z16, 30)
config.enable_stream(rs.stream.color, 1920, 1080, rs.format.bgr8, 30)
profile = pipeline.start(config)
device = profile.get_device()
adv = rs.rs400_advanced_mode(device)
if not adv.is_enabled():
    adv.toggle_advanced_mode(True)
sensor = device.first_depth_sensor()
sensor.set_option(rs.option.visual_preset, 1)
sensor.set_option(rs.option.enable_auto_exposure, 1)
scale_mm = None

rgb = next(s for s in device.query_sensors() if s.get_info(rs.camera_info.name) == "RGB Camera")
sharpness = int(rgb.get_option(rs.option.sharpness))
rgb_auto = True
rgb_exp = 156   # RealSense color exposure units (~1/10000 s)
rgb_gain = 64

def apply_rgb():
    rgb.set_option(rs.option.sharpness, sharpness)
    if rgb_auto:
        rgb.set_option(rs.option.enable_auto_exposure, 1)
    else:
        rgb.set_option(rs.option.enable_auto_exposure, 0)
        rgb.set_option(rs.option.exposure, rgb_exp)
        rgb.set_option(rs.option.gain, rgb_gain)

def apply_shift():
    t = adv.get_depth_table()
    t.disparityShift = shift
    t.depthUnits = 100
    adv.set_depth_table(t)

def apply_laser():
    if laser <= 0:
        sensor.set_option(rs.option.emitter_enabled, 0)
    else:
        sensor.set_option(rs.option.emitter_enabled, 1)
        sensor.set_option(rs.option.laser_power, laser)

apply_shift()
apply_laser()
apply_rgb()
scale_mm = sensor.get_depth_scale() * 1000.0

def crop_zoom(img):
    h, w = img.shape[:2]
    cw, ch = int(w / zoom), int(h / zoom)
    x1 = int(np.clip(cx * w - cw / 2, 0, w - cw))
    y1 = int(np.clip(cy * h - ch / 2, 0, h - ch))
    return img[y1:y1 + ch, x1:x1 + cw], (x1, y1, x1 + cw, y1 + ch)

def colorize(depth_mm):
    lo, hi = DEPTH_WIN_MM
    vis = np.clip((depth_mm - lo) / (hi - lo), 0, 1)
    u8 = (vis * 255).astype(np.uint8)
    col = cv2.applyColorMap(255 - u8, cv2.COLORMAP_TURBO)
    col[depth_mm <= 0] = 0
    return col

cv2.namedWindow("D415 Live Tuner", cv2.WINDOW_AUTOSIZE)
snap = 0
smooth = None
while True:
    frames = pipeline.wait_for_frames()
    color = np.asanyarray(frames.get_color_frame().get_data())
    depth_mm = np.asanyarray(frames.get_depth_frame().get_data()).astype(np.float32) * scale_mm
    # light temporal smoothing for display
    if smooth is None or smooth.shape != depth_mm.shape:
        smooth = depth_mm.copy()
    else:
        m = depth_mm > 0
        smooth[m] = 0.6 * smooth[m] + 0.4 * depth_mm[m]
        smooth[~m] = 0
    zc, rect = crop_zoom(color)
    zd, _ = crop_zoom(smooth)

    overview = cv2.resize(color, PANEL)
    sx, sy = PANEL[0] / color.shape[1], PANEL[1] / color.shape[0]
    cv2.rectangle(overview, (int(rect[0] * sx), int(rect[1] * sy)),
                  (int(rect[2] * sx), int(rect[3] * sy)), (0, 255, 255), 1)
    p_color = cv2.resize(zc, PANEL, interpolation=cv2.INTER_CUBIC)
    p_depth = cv2.resize(colorize(zd), PANEL, interpolation=cv2.INTER_NEAREST)

    valid = zd[zd > 0]
    fill = 100.0 * len(valid) / zd.size if zd.size else 0
    med = np.median(valid) / 10 if len(valid) else 0
    gray = cv2.cvtColor(zc, cv2.COLOR_BGR2GRAY)
    focus = cv2.Laplacian(gray, cv2.CV_64F).var()

    canvas = np.zeros((PANEL[1] + 46, PANEL[0] * 3 + 8, 3), dtype=np.uint8)
    canvas[0:PANEL[1], 0:PANEL[0]] = overview
    canvas[0:PANEL[1], PANEL[0] + 4:PANEL[0] * 2 + 4] = p_color
    canvas[0:PANEL[1], PANEL[0] * 2 + 8:PANEL[0] * 3 + 8] = p_depth
    exp_txt = "auto" if rgb_auto else f"exp {rgb_exp} gain {rgb_gain}"
    txt1 = (f"shift {shift}  laser {int(laser)}  sharp {sharpness}  rgb {exp_txt}  "
            f"zoom {zoom:.1f}x | FOCUS {focus:.0f} | fill {fill:.0f}%  median {med:.1f}cm")
    txt2 = "z/x shift  c/v laser  j/k sharp  e autoexp  d/f exp  g/h gain  -/+ zoom  arrows pan  s save  p premium  q quit"
    cv2.putText(canvas, txt1, (8, PANEL[1] + 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1)
    cv2.putText(canvas, txt2, (8, PANEL[1] + 38), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (160, 160, 160), 1)
    cv2.imshow("D415 Live Tuner", canvas)

    k = cv2.waitKeyEx(1)
    if k in (ord('q'), 27):
        break
    elif k == ord('z'):
        shift = max(0, shift - 20); apply_shift()
    elif k == ord('x'):
        shift = min(400, shift + 20); apply_shift()
    elif k == ord('c'):
        laser = max(0, laser - 30); apply_laser()
    elif k == ord('v'):
        laser = min(360, laser + 30); apply_laser()
    elif k == ord('j'):
        sharpness = max(0, sharpness - 10); apply_rgb()
    elif k == ord('k'):
        sharpness = min(100, sharpness + 10); apply_rgb()
    elif k == ord('e'):
        rgb_auto = not rgb_auto; apply_rgb()
    elif k == ord('d'):
        rgb_auto = False; rgb_exp = max(10, rgb_exp - 30); apply_rgb()
    elif k == ord('f'):
        rgb_auto = False; rgb_exp = min(2000, rgb_exp + 30); apply_rgb()
    elif k == ord('g'):
        rgb_auto = False; rgb_gain = max(0, rgb_gain - 8); apply_rgb()
    elif k == ord('h'):
        rgb_auto = False; rgb_gain = min(128, rgb_gain + 8); apply_rgb()
    elif k in (ord('-'), ord('_')):
        zoom = max(1.0, zoom - 0.5)
    elif k in (ord('+'), ord('=')):
        zoom = min(8.0, zoom + 0.5)
    elif k == 2424832:  # left
        cx = max(0.0, cx - 0.05)
    elif k == 2555904:  # right
        cx = min(1.0, cx + 0.05)
    elif k == 2490368:  # up
        cy = max(0.0, cy - 0.05)
    elif k == 2621440:  # down
        cy = min(1.0, cy + 0.05)
    elif k == ord('p'):
        tag = time.strftime("%H%M%S")
        acc = []
        for _ in range(30):
            f = pipeline.wait_for_frames()
            acc.append(np.asanyarray(f.get_color_frame().get_data()).astype(np.float32))
        avg = np.mean(acc, axis=0).astype(np.uint8)
        zp, _ = crop_zoom(avg)
        cv2.imwrite(os.path.join(OUT_DIR, f"premium_{tag}_full.png"), avg)
        cv2.imwrite(os.path.join(OUT_DIR, f"premium_{tag}_zoom.png"),
                    cv2.resize(zp, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
        print(f"premium saved premium_{tag}_* (focus={focus:.0f}, zoom={zoom:.1f}x)")
    elif k == ord('s'):
        snap += 1
        tag = time.strftime("%H%M%S")
        cv2.imwrite(os.path.join(OUT_DIR, f"live_{tag}_view.png"), canvas)
        cv2.imwrite(os.path.join(OUT_DIR, f"live_{tag}_colorzoom.png"),
                    cv2.resize(zc, None, fx=2, fy=2, interpolation=cv2.INTER_CUBIC))
        cv2.imwrite(os.path.join(OUT_DIR, f"live_{tag}_depthzoom.png"), colorize(zd))
        print(f"saved live_{tag}_* (shift={shift}, laser={int(laser)})")

pipeline.stop()
cv2.destroyAllWindows()
