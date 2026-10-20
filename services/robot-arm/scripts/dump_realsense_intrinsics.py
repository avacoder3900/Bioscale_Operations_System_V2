"""Write the RealSense factory colour intrinsics for every colour resolution to JSON.

pyrealsense2 has no wheel for the robot-arm service's Python 3.13, so run this
once (and again after swapping the camera) with a throwaway Python 3.12:

    uv run --no-project --python 3.12 --with pyrealsense2 \
        scripts/dump_realsense_intrinsics.py calibrations/realsense_color_intrinsics.json

apriltags.py reads the file for whatever resolution cameras.py is streaming.
"""

import json
import sys
import time

import pyrealsense2 as rs

out = {"device": None, "serial": None, "read_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "color": {}}
for dev in rs.context().query_devices():
    out["device"] = dev.get_info(rs.camera_info.name)
    out["serial"] = dev.get_info(rs.camera_info.serial_number)
    for sensor in dev.query_sensors():
        for sp in sensor.get_stream_profiles():
            if sp.stream_type() != rs.stream.color:
                continue
            vp = sp.as_video_stream_profile()
            i = vp.get_intrinsics()
            out["color"][f"{vp.width()}x{vp.height()}"] = {
                "fx": round(i.fx, 4),
                "fy": round(i.fy, 4),
                "cx": round(i.ppx, 4),
                "cy": round(i.ppy, 4),
                "dist": [float(c) for c in i.coeffs],
                "model": str(i.model),
            }
    break

if not out["color"]:
    sys.exit("no RealSense colour stream found")
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(out, f, indent=2)
print(out["device"], out["serial"], sorted(out["color"]))
