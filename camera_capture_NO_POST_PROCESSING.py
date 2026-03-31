import cv2
import time
import os

# ============================================================
# LIZA DIAGNOSTIC - RAW CAPTURE WITH QR CODE IDENTIFICATION
# No pyzbar - OpenCV only, no external DLL dependencies
# Saves images as: raw_capture_QRDATA_001.png
# ============================================================

# ============================================================
# TUNING PANEL
# ============================================================

SAVE_FOLDER = r"C:\Users\athrailkill\Desktop\LIZA_Captures"
CAMERA_INDEX = 1
EXPOSURE = -5

# ============================================================
# DO NOT CHANGE ANYTHING BELOW THIS LINE
# ============================================================

os.makedirs(SAVE_FOLDER, exist_ok=True)

print("Connecting to camera...")
cap = None
for attempt in range(5):
    cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
    if cap.isOpened():
        ret, test_frame = cap.read()
        if ret and test_frame is not None:
            print(f"Camera connected on attempt {attempt + 1}")
            break
        else:
            print(f"Camera opened but not streaming - retry {attempt + 1}/5")
            cap.release()
            time.sleep(2)
    else:
        print(f"Camera not found - retry {attempt + 1}/5")
        time.sleep(2)

if not cap or not cap.isOpened():
    print("ERROR: Could not connect to camera after 5 attempts.")
    exit()

cap.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
cap.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
cap.set(cv2.CAP_PROP_FPS, 30)
cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)
cap.set(cv2.CAP_PROP_EXPOSURE, EXPOSURE)
cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
cap.set(cv2.CAP_PROP_AUTO_WB, 0)
cap.set(cv2.CAP_PROP_GAIN, 0)
cap.set(cv2.CAP_PROP_BRIGHTNESS, 128)
cap.set(cv2.CAP_PROP_CONTRAST, 128)
cap.set(cv2.CAP_PROP_SHARPNESS, 0)
cap.set(cv2.CAP_PROP_SATURATION, 128)
cap.set(cv2.CAP_PROP_GAMMA, 100)
cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)

print("Flushing camera buffer...")
for i in range(20):
    cap.read()
    time.sleep(0.05)

print("Camera ready.")
print("---- Current Camera Settings ----")
print("Exposure:       ", cap.get(cv2.CAP_PROP_EXPOSURE))
print("Auto Exposure:  ", cap.get(cv2.CAP_PROP_AUTO_EXPOSURE))
print("Gain:           ", cap.get(cv2.CAP_PROP_GAIN))
print("FPS:            ", cap.get(cv2.CAP_PROP_FPS))
print("---------------------------------")
print("Press C to capture image")
print("Press Q to quit")
print(f"Images saving to: {SAVE_FOLDER}")

# ============================================================
# QR DETECTOR SETUP
# Tries WeChatQRCode first (more powerful, from contrib)
# Falls back to basic OpenCV detector automatically
# No pyzbar, no external DLLs needed
# ============================================================
use_wechat = False
try:
    qr_detector = cv2.wechat_qrcode_WeChatQRCode()
    use_wechat = True
    print("QR detector: WeChatQRCode (high accuracy)")
except:
    qr_detector = cv2.QRCodeDetector()
    print("QR detector: OpenCV basic")

# ============================================================
# QR READ FUNCTION
# ============================================================
def read_qr(frame):
    qr_data = None
    points = None

    try:
        if use_wechat:
            results, points_list = qr_detector.detectAndDecode(frame)
            if results:
                qr_data = results[0]
                if points_list:
                    points = points_list[0].astype(int)
        else:
            data, pts, _ = qr_detector.detectAndDecode(frame)
            if data:
                qr_data = data
                if pts is not None:
                    points = pts[0].astype(int)
    except:
        pass

    # Draw green box around QR on display frame if detected
    if qr_data and points is not None:
        for j in range(4):
            pt1 = tuple(points[j])
            pt2 = tuple(points[(j + 1) % 4])
            cv2.line(frame, pt1, pt2, (0, 255, 0), 2)

    return qr_data, frame

# ============================================================
# FILENAME SANITIZER
# Removes illegal Windows filename characters from QR data
# ============================================================
def sanitize_filename(text):
    illegal_chars = '/\\:*?"<>|'
    for char in illegal_chars:
        text = text.replace(char, "_")
    # Also limit length to keep filenames manageable
    return text[:60]

window_name = "LIZA RAW CAPTURE - C to capture, Q to quit"
cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
cv2.resizeWindow(window_name, 960, 540)

def reconnect():
    global cap
    print("Camera disconnected - attempting reconnect...")
    cap.release()
    time.sleep(3)
    for attempt in range(5):
        cap = cv2.VideoCapture(CAMERA_INDEX, cv2.CAP_DSHOW)
        if cap.isOpened():
            ret, test = cap.read()
            if ret and test is not None:
                cap.set(cv2.CAP_PROP_FPS, 30)
                cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)
                cap.set(cv2.CAP_PROP_EXPOSURE, EXPOSURE)
                cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
                cap.set(cv2.CAP_PROP_AUTO_WB, 0)
                cap.set(cv2.CAP_PROP_GAIN, 0)
                cap.set(cv2.CAP_PROP_BRIGHTNESS, 128)
                cap.set(cv2.CAP_PROP_CONTRAST, 128)
                cap.set(cv2.CAP_PROP_SHARPNESS, 0)
                cap.set(cv2.CAP_PROP_SATURATION, 128)
                cap.set(cv2.CAP_PROP_GAMMA, 100)
                cap.set(cv2.CAP_PROP_BUFFERSIZE, 1)
                for i in range(20):
                    cap.read()
                    time.sleep(0.05)
                print("Reconnected and settings restored.")
                return True
        print(f"Reconnect attempt {attempt + 1}/5 failed...")
        time.sleep(2)
    print("Could not reconnect. Check USB cable.")
    return False

# ============================================================
# MAIN LOOP
# ============================================================
image_counter = 1
fail_count = 0
max_fails = 10
current_qr = None

while True:
    ret, frame = cap.read()

    if not ret:
        fail_count += 1
        print(f"Frame grab failed ({fail_count}/{max_fails})")
        time.sleep(0.2)
        if fail_count >= max_fails:
            success = reconnect()
            fail_count = 0
            if not success:
                print("Camera unrecoverable. Exiting.")
                break
        continue

    fail_count = 0

    # Keep raw frame clean for saving
    # Draw QR box and status text on display copy only
    display_frame = frame.copy()
    qr_data, display_frame = read_qr(display_frame)

    if qr_data:
        if qr_data != current_qr:
            print(f"QR detected: {qr_data}")
        current_qr = qr_data

    # Status overlay on display frame
    if current_qr:
        status_text = f"QR: {current_qr[:50]}"
        color = (0, 255, 0)   # green = detected
    else:
        status_text = "QR: NOT DETECTED"
        color = (0, 0, 255)   # red = not detected

    cv2.putText(display_frame, status_text, (20, 40),
                cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)

    cv2.imshow(window_name, display_frame)

    key = cv2.waitKey(1) & 0xFF

    if key == ord('c'):
        if not current_qr:
            print("WARNING: No QR code detected. Saving as UNKNOWN.")
            qr_label = "UNKNOWN"
        else:
            qr_label = sanitize_filename(current_qr)

        filename = os.path.join(
            SAVE_FOLDER,
            f"raw_capture_{qr_label}_{image_counter:03d}.png"
        )

        # Save raw unmodified frame not display frame
        cv2.imwrite(filename, frame)
        print(f"Raw image saved: {filename}")
        image_counter += 1

    if key == ord('q'):
        print("Quitting.")
        break

cap.release()
cv2.destroyAllWindows()
print("Camera released. Script complete.")