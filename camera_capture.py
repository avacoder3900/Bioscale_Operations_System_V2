import cv2
import time
import numpy as np
import os

# ============================================================
# LIZA DIAGNOSTIC - CAPTURE WITH POST PROCESSING + QR READER
# Saves images as: cartridge_capture_QRDATA_001.png
# ============================================================

# ============================================================
# TUNING PANEL - ONLY CHANGE VALUES IN THIS SECTION
# ============================================================

SAVE_FOLDER = r"C:\Users\athrailkill\Desktop\LIZA_Captures"
CAMERA_INDEX = 1

EXPOSURE = -5
WHITE_BALANCE = 4000
BRIGHTNESS = 128
CONTRAST = 128
CLAHE_STRENGTH = 2.0
GAMMA = 0.85

RED_CORRECTION = 0.85
GREEN_CORRECTION = 0.90
BLUE_CORRECTION = 1.0

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
cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)
cap.set(cv2.CAP_PROP_EXPOSURE, EXPOSURE)
cap.set(cv2.CAP_PROP_AUTOFOCUS, 0)
cap.set(cv2.CAP_PROP_AUTO_WB, 0)
cap.set(cv2.CAP_PROP_WB_TEMPERATURE, WHITE_BALANCE)
cap.set(cv2.CAP_PROP_BRIGHTNESS, BRIGHTNESS)
cap.set(cv2.CAP_PROP_CONTRAST, CONTRAST)
cap.set(cv2.CAP_PROP_GAIN, 0)
cap.set(cv2.CAP_PROP_SHARPNESS, 128)

print("Flushing camera buffer...")
for i in range(20):
    cap.read()
    time.sleep(0.05)

print("Camera ready.")
print("---- Current Camera Settings ----")
print("Exposure:       ", cap.get(cv2.CAP_PROP_EXPOSURE))
print("Auto Exposure:  ", cap.get(cv2.CAP_PROP_AUTO_EXPOSURE))
print("White Balance:  ", cap.get(cv2.CAP_PROP_WB_TEMPERATURE))
print("Brightness:     ", cap.get(cv2.CAP_PROP_BRIGHTNESS))
print("Contrast:       ", cap.get(cv2.CAP_PROP_CONTRAST))
print("---------------------------------")
print("Press C to capture image")
print("Press Q to quit")
print(f"Images saving to: {SAVE_FOLDER}")

# ============================================================
# QR DETECTOR SETUP
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
# Reads QR on display copy only
# Raw frame stays unmodified for saving
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

    # Draw green box around QR on display frame
    if qr_data and points is not None:
        for j in range(4):
            pt1 = tuple(points[j])
            pt2 = tuple(points[(j + 1) % 4])
            cv2.line(frame, pt1, pt2, (0, 255, 0), 2)

    return qr_data, frame

# ============================================================
# FILENAME SANITIZER
# ============================================================
def sanitize_filename(text):
    illegal_chars = '/\\:*?"<>|'
    for char in illegal_chars:
        text = text.replace(char, "_")
    return text[:60]

# ============================================================
# POST PROCESSING FUNCTION
# ============================================================
def process_frame(frame):

    # STEP 1 - COLOR CORRECTION
    b_ch, g_ch, r_ch = cv2.split(frame)
    r_ch = cv2.multiply(r_ch, RED_CORRECTION)
    g_ch = cv2.multiply(g_ch, GREEN_CORRECTION)
    b_ch = cv2.multiply(b_ch, BLUE_CORRECTION)
    frame = cv2.merge([b_ch, g_ch, r_ch])

    # STEP 2 - DENOISE
    denoised = cv2.GaussianBlur(frame, (3, 3), 0)

    # STEP 3 - CLAHE local contrast enhancement
    lab = cv2.cvtColor(denoised, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=CLAHE_STRENGTH, tileGridSize=(8, 8))
    l_enhanced = clahe.apply(l)
    lab_enhanced = cv2.merge([l_enhanced, a, b])
    contrast_enhanced = cv2.cvtColor(lab_enhanced, cv2.COLOR_LAB2BGR)

    # STEP 4 - GAMMA CORRECTION
    inv_gamma = 1.0 / GAMMA
    table = np.array([
        ((i / 255.0) ** inv_gamma) * 255
        for i in np.arange(256)
    ]).astype("uint8")
    gamma_corrected = cv2.LUT(contrast_enhanced, table)

    # STEP 5 - SHARPEN
    sharpen_kernel = np.array([[ 0, -1,  0],
                                [-1,  5, -1],
                                [ 0, -1,  0]])
    sharpened = cv2.filter2D(gamma_corrected, -1, sharpen_kernel)

    return sharpened

# ============================================================
# WINDOW SETUP
# ============================================================
window_name = "LIZA Diagnostic Camera - C to capture, Q to quit"
cv2.namedWindow(window_name, cv2.WINDOW_NORMAL)
cv2.resizeWindow(window_name, 960, 540)

# ============================================================
# RECONNECT FUNCTION
# ============================================================
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
                cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 1)
                cap.set(cv2.CAP_PROP_EXPOSURE, EXPOSURE)
                cap.set(cv2.CAP_PROP_AUTO_WB, 0)
                cap.set(cv2.CAP_PROP_WB_TEMPERATURE, WHITE_BALANCE)
                cap.set(cv2.CAP_PROP_BRIGHTNESS, BRIGHTNESS)
                cap.set(cv2.CAP_PROP_CONTRAST, CONTRAST)
                cap.set(cv2.CAP_PROP_SHARPNESS, 128)
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
# Post processing applied to display and saved image
# QR box and status drawn on display copy only
# Saved image has post processing but no QR overlay
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

    # Apply post processing to raw frame for saving
    processed_frame = process_frame(frame)

    # Copy processed frame for display - QR box drawn on copy only
    display_frame = processed_frame.copy()
    qr_data, display_frame = read_qr(display_frame)

    if qr_data:
        if qr_data != current_qr:
            print(f"QR detected: {qr_data}")
        current_qr = qr_data

    # QR status overlay on display only
    if current_qr:
        status_text = f"QR: {current_qr[:50]}"
        color = (0, 255, 0)
    else:
        status_text = "QR: NOT DETECTED"
        color = (0, 0, 255)

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
            f"cartridge_capture_{qr_label}_{image_counter:03d}.png"
        )

        # Save post processed frame without QR overlay
        cv2.imwrite(filename, processed_frame)
        print(f"Image saved: {filename}")
        image_counter += 1

    if key == ord('q'):
        print("Quitting.")
        break

cap.release()
cv2.destroyAllWindows()
print("Camera released. Script complete.")