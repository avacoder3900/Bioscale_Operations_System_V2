# RealSense D415 — Close-Range Cartridge Imaging (CV Better Camera)

**Status:** working rig validated 2026-07-06 · **Owner:** Alejandro · **Pick-up point:** see [Where this left off](#where-this-left-off)

Depth + color imaging of Brevitest cartridges with an Intel RealSense D415, tuned for
close range (~11–30 cm). Everything below was empirically validated over ~29 test
captures against the real cartridge in its black holder.

## Hardware

| Item | Value |
|---|---|
| Camera | Intel RealSense D415, SN `353122063190` |
| Firmware | 5.17.0.10 (current production FW as of 2026-07) |
| Connection | must be USB 3.x (shows `3.2` in `rs-enumerate-devices`) — USB 2 silently caps resolution |
| SDK | librealsense v2.58.2 · `pyrealsense2==2.58.2` (Python 3.14, `C:\Python314`) |
| Standalone tools | `RealSense.Viewer.exe`, `Depth.Quality.Tool.exe`, `rs-enumerate-devices.exe` in `~\Downloads` |

## Validated settings — depth (fine 3D detail)

| Setting | Value | Notes |
|---|---|---|
| Stream | 1280×720 @ 30 fps, Z16 | D415's native optimal depth resolution |
| Visual preset | Default | High Accuracy → ~0% fill; High Density → noisier, no gain |
| Laser power | **60** | low power won every test (less bloom/ghosting on plastics) |
| Stereo exposure | Auto | beat every manual exposure combination tried |
| Depth units | 100 µm | sub-mm quantization |
| Disparity shift | **320** → 11–18 cm · **200** → 17–30 cm · **100** → 22–45 cm | pick by working distance |
| Frames | median-composite 30–60 frames | biggest single quality win on static scenes |

Best measured result: **80% fill, ±10 mm** on the (taped) cartridge at ~11.5 cm
(test25). On plain matte surfaces expect ±1–3 mm relative detail.

## Validated settings — color (fine photo detail)

| Setting | Value | Notes |
|---|---|---|
| Stream | 1920×1080 | sensor max; 720p wastes real detail |
| Height | **focus peak ≈ 180–220 mm** | lens is fixed-focus; at 120 mm it is optically blurred — no setting fixes it |
| Emitter | OFF (`emitter_enabled=0`) | `laser_power 0` alone does NOT stop the purple IR blotch |
| Gain / exposure | gain minimum, exposure long, manual | static scene → long exposure is free quality |
| Sharpness | 70–100 | |
| Capture | average 15–30 frames | kills sensor grain |

**Core trade-off:** depth wants ~120 mm, color wants ~200 mm. For one object:
capture depth low, then raise to the focus peak for the photo.

## Physics rules (matter more than any setting)

- **Clear cartridge plastic is invisible at 850 nm** — IR passes through and ranges on
  whatever is underneath. Wells show as depth voids (usable for locating them, not for
  measuring inside them). For surface depth: masking tape (proven) or vanishing
  3D-scan spray (AESUB Blue) for conformal captures.
- **Black PLA holder** absorbs IR at distance but reads fine close-up.
- **Acrylic/glossy sheets under or behind the scene retro-reflect the dot projector**
  and poison the whole frame, worst when viewing perpendicular. Matte background
  (paper/cardboard) fixed it immediately.
- Tilt the camera **5–10° off perpendicular** so specular glints miss the lens.
- Below ~15 cm at 1280×720 the dot pattern **aliases into moiré rings** — this is the
  hard floor; the D405 is the camera for closer work.
- Sub-mm well geometry is beyond this camera in any configuration (±3–10 mm depth
  noise vs ~1 mm features). Realistic D415 jobs: well/hole localization, cartridge
  presence + orientation, gross surface measurement, positioning for a macro camera.

## Scripts (`scripts/realsense/`)

All output goes to `C:\Users\aleja\Desktop\realsense-captures\` (also holds all test
images from the validation day, `test5`–`test29`, `premium_*`).

| Script | Purpose |
|---|---|
| `rs_live.py` | **Live tuner** — 3-panel window (overview / color zoom / depth zoom), keyboard control of every setting, live Laplacian FOCUS score for finding the sharp height, `s` snapshot, `p` premium 30-frame-averaged shot, `q` quit cleanly |
| `rs_shot.py` | Scripted capture: color + IR + N-frame median depth composite + stats JSON. Ex: `python rs_shot.py --name mytest --disparity-shift 320 --laser-power 60 --frames 60` |
| `rs_fuse.py` | Multi-disparity-shift fusion (union of 3 depth windows → 86% fill). Note: windows carry mm-scale systematic offsets between shifts — don't gate on tight cross-window agreement |
| `rs_capture.py` | Earlier single-frame capture tool (superseded by `rs_shot.py`) |

## RealSense Viewer setup (GUI equivalent)

Stereo Module 1280×720@30 → preset Default, Laser 60, Auto Exposure ON →
Advanced Controls → Depth Table: Disparity Shift per distance, Depth Units 100.
**Post-Processing: turn Decimation Filter OFF** (ships ON — silently halves depth
resolution); Temporal + Spatial ON. Depth colorizer: fixed range (e.g. 0.10–0.18 m),
not histogram equalization. RGB 1920×1080, Sharpness 100.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Failed to resolve the request: Format: Z16 ...` on open | camera stuck after an app died mid-stream → `python -c "import pyrealsense2 as rs; rs.context().query_devices()[0].hardware_reset()"` or replug USB |
| Low res / missing modes | enumerated on USB 2 — check `Usb Type Descriptor` via `rs-enumerate-devices -S`, reseat cable into a USB 3 port |
| `cv2.imshow` "not implemented" | `opencv-python-headless` shadowing `opencv-python` → uninstall both, reinstall `opencv-python` |
| numpy import crash (exit 5, MinGW warning) | broken MinGW wheel → `pip install --force-reinstall --only-binary :all: numpy` |
| Purple blotch in color image | IR emitter → set `emitter_enabled=0` (not just laser power 0) |
| Only one app can use the camera | close RealSense Viewer before running scripts, and vice versa |

## Where this left off

- Full depth + color recipe validated; live tuner working; one `premium_143241_*`
  focus-peak shot captured.
- **Not yet done:** measure and record the exact focus-peak height for the rig;
  AESUB-spray depth capture of an untreated cartridge; decision on a macro camera
  (USB microscope or Pi close-focus cam) for sub-mm well imaging, with the D415 kept
  for positioning/orientation.
- Possible next build: turnkey scan script (position via depth voids → auto premium
  photo → save set), or wiring captures into the BIMS capture-station flow.
