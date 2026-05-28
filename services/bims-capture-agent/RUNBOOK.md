# bims-capture-agent — Setup Runbook

Step-by-step guide for bringing a Raspberry Pi 5 capture station from a blank SD card to a working remote camera + barcode scanner connected to BIMS V2. Includes verification checks at each phase, known failure modes with fixes, and a recovery procedure when things break.

Validated against `bims-capture-agent` branch, commit `f1109e8b` and later.

---

## Hardware baseline

- Raspberry Pi 5 (2GB or 4GB), with a 5V/5A USB-C PD supply (5V/3A works but may undervolt)
- microSD card, 32GB+, flashed with Raspberry Pi OS Bookworm/Trixie (64-bit recommended)
- USB UVC webcam at `/dev/video0` (any standard UVC camera; LED-ringed ones are easier to light)
- Waveshare Barcode Scanner Module (VID `0218` / PID `0210`) — **must be set to Continuous Mode** with HID keyboard interface (see "First-time scanner setup" below)
- Ethernet cable (for initial setup with ICS), or known WiFi network the Pi can join

## Account / service prereqs

- Tailscale account, tailnet has **HTTPS Certificates** enabled
- GitHub access to `avacoder3900/Bioscale_Operations_System_V2`
- BIMS V2 deployment on Vercel, with a user that has `cv:write` or `manufacturing:write` permission

---

## Phase 1 — Get the Pi online

### 1.1 Flash the SD card

Use **Raspberry Pi Imager**. Pre-configure in the OS customization dialog:
- Hostname: something descriptive (e.g. `alejandrospi`)
- Username + password
- Enable SSH (password or key)
- WiFi credentials (informational — will fall back to Ethernet via ICS if WiFi is unavailable)
- Locale + keyboard layout

The Imager writes `user-data` and `network-config` to the FAT `bootfs` partition for cloud-init to consume on first boot.

### 1.2 First boot

Insert SD, power on. **First boot takes 60–90 seconds** while cloud-init:
- Expands rootfs to fill the SD card
- Creates the user account from the hashed password in `user-data`
- Generates SSH host keys
- May reboot once after first-run setup completes

**Pi 5 LED guide:** the Pi 5 has only one user-facing LED (next to the USB-C port). **Steady green = OS running normally.** Pi 5 does NOT blink the green LED for SD-card activity the way Pi 4 does. This is the most common source of "my Pi is broken" confusion when migrating from Pi 4.

### 1.3 Get on the network

**If on real WiFi:** the Pi joins automatically per `network-config`, and gets a DHCP lease from the router. Find its IP via mDNS (`ping <hostname>.local`) or your router's admin UI.

**If on hotspot via Ethernet + Internet Connection Sharing (ICS):**
1. On the laptop, open `ncpa.cpl` (Network Connections)
2. Right-click the WiFi adapter that has internet → Properties → Sharing tab
3. Enable "Allow other network users to connect through this computer's Internet connection"
4. Set "Home networking connection" to Ethernet
5. The laptop's Ethernet adapter switches to `192.168.137.1`
6. Plug the cable Pi ↔ laptop. The Pi gets a DHCP lease from ICS in the `192.168.137.x/24` range.
7. Find the Pi's IP from the laptop with:
   ```powershell
   arp -a | findstr 192.168.137
   ```

### 1.4 SSH in

```
ssh <user>@<pi-hostname>
```

or by IP. Accept the host key fingerprint on first connect.

**Verification check #1:** `hostname` returns the expected hostname, `df -h /` shows the rootfs filled the SD card (not 2GB), `free -h` shows RAM available, and `ping -c 3 8.8.8.8` works (Pi has internet).

---

## Phase 2 — Install Tailscale

The Pi needs to be reachable from the operator's browser (and from anywhere you SSH from). Tailscale + MagicDNS is the cleanest answer.

### 2.1 Install + auth

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up --hostname=<pi-cv-name> --ssh
```

The `up` command prints an auth URL — open it on a device that's logged into your tailnet and approve the Pi.

### 2.2 Verify

From the laptop (also on the tailnet):
```
tailscale status
ping <pi-cv-name>
```

You should see the Pi listed and ping the MagicDNS name.

**Verification check #2:** SSH using the Tailscale name works without specifying IP:
```
ssh <user>@<pi-cv-name>
```

After this, the Pi's local network can change (move buildings, switch APs) and the Tailscale name keeps resolving.

---

## Phase 3 — Install the agent

### 3.1 Sparse-checkout (avoids cloning the whole BIMS repo)

```bash
mkdir -p ~/bims-capture-agent && cd ~/bims-capture-agent
git init
git remote add origin https://github.com/avacoder3900/Bioscale_Operations_System_V2.git
git config core.sparseCheckout true
echo "services/bims-capture-agent/*" > .git/info/sparse-checkout
git pull --depth=1 origin bims-capture-agent
cd services/bims-capture-agent
```

If the repo is private, this prompts for GitHub credentials. Use a Personal Access Token (Settings → Developer settings → Personal access tokens → repo scope) as the password.

### 3.2 Install system packages

```bash
sudo apt update
sudo apt install -y uuid-runtime python3-venv
```

`uuid-runtime` is required by `setup-station.sh` for `uuidgen`. `python3-venv` is needed if it's not already installed.

### 3.3 Create venv + install Python deps

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip wheel
pip install -r requirements.txt
```

**Heads up:** `aiortc` and `opencv-python` are the slow installs. On hotspot bandwidth this can take 10–20 minutes. On real WiFi it's ~2 minutes. If `aiortc` fails to build, install: `sudo apt install -y libavdevice-dev libavfilter-dev libopus-dev libvpx-dev libsrtp2-dev pkg-config` and retry.

### 3.4 Run setup-station.sh

```bash
sudo bash setup-station.sh
```

Answer the prompts:
- **Station name** — friendly label, e.g. `Wax Fill Bench 1`
- **BIMS server URL** — the Vercel deployment URL, **using the branch-alias URL** (no build hash): `https://bioscale-operations-system-mongodb-git-bims-capture-agent-brevitest.vercel.app`. Branch-alias URLs are stable across deploys; build-hash URLs go stale.
- **Station token** — leave blank to auto-generate
- **WiFi SSID** — informational only, just for documentation in the env file
- **Cloudflare Tunnel token** — leave blank (Phase 5 placeholder)

The script writes `/etc/bims/station.env`.

**Verification check #3:**
```bash
sudo cat /etc/bims/station.env
```
Confirm `STATION_ID`, `STATION_NAME`, `STATION_TOKEN`, `BIMS_URL`, `PORT=8765` are all populated.

---

## Phase 4 — Register the station with BIMS

BIMS needs a `CaptureStation` document so the `/capture` page can offer the station in its dropdown. There is no admin UI for this yet — register via DevTools fetch.

### 4.1 Open BIMS and log in

In a browser, go to the BIMS V2 deployment URL. Log in as a user with `cv:write` or `manufacturing:write` permission.

### 4.2 POST to /api/cv/stations

Press **F12** → Console tab, and paste:

```javascript
fetch('/api/cv/stations', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    name: 'CV station test 1',                                    // match STATION_NAME
    hostname: '<pi-cv-name>.<tailnet>.ts.net',                    // full Tailscale FQDN
    capabilities: { camera: true, scanner: true, led: false, robotArm: false },
    agentVersion: '0.1.0'
  })
}).then(r => r.json()).then(j => console.log(JSON.stringify(j, null, 2)))
```

You'll get back one of:
- `{ "_id": "...", "jwtSecret": "..." }` — **first-time registration succeeded** — copy the `jwtSecret`
- `{ "_id": "..." }` — already registered (only `_id`, no jwtSecret returned)
- `{ "error": "..." }` — permission or validation error

If you already registered and lost the jwtSecret, you'll need to re-register with a different hostname OR delete the existing CaptureStation document from MongoDB to start fresh.

### 4.3 Add the JWT secret to the Pi env

On the Pi, append the secret to the env file. **Use single quotes** because the secret usually contains `/` and `=`:

```bash
echo 'STATION_JWT_SECRET=<paste secret>' | sudo tee -a /etc/bims/station.env
```

If a previous attempt added the wrong secret, edit with `sudo nano /etc/bims/station.env` and replace the line.

**Verification check #4:**
```bash
sudo grep STATION_JWT_SECRET /etc/bims/station.env
```
Should print a single line with the secret.

---

## Phase 5 — TLS termination via Tailscale Serve

The browser will open `wss://<pi-cv-name>.<tailnet>.ts.net/ws?token=...` — default port 443 with TLS. The agent itself listens on plain HTTP port 8765. Use `tailscale serve` to terminate TLS on 443 and proxy to the agent.

```bash
sudo tailscale serve --bg --https=443 http://localhost:8765
```

Verify:
```bash
tailscale serve status
```

Should print:
```
https://<pi-cv-name>.<tailnet>.ts.net (tailnet only)
|-- / proxy http://localhost:8765
```

**Verification check #5:** from the laptop:
```powershell
curl.exe -s https://<pi-cv-name>.<tailnet>.ts.net/health
```
Should return JSON, NOT a 502. (502 = port 8765 nothing listening — agent isn't running.)

---

## Phase 6 — Install as a systemd service

Run the agent under systemd so it auto-starts on boot, restarts on crash, and survives SSH disconnects.

### 6.1 Create the `bims` system user

The included `bims-capture-agent.service` unit runs as `User=bims`. Create that user and add it to the groups that own the camera/scanner device nodes:

```bash
sudo groupadd -r bims
sudo useradd -r -g bims -G input,video -s /usr/sbin/nologin -d /opt/bims-capture-agent -M bims
```

`input` group owns `/dev/input/event*` (scanner). `video` group owns `/dev/video*` (camera). `-s /usr/sbin/nologin` makes the account uninteractive. `-M -d` sets the home dir without creating it (so the symlink in 6.2 is what answers).

### 6.2 Symlink `/opt/bims-capture-agent` → home checkout

The service unit's `WorkingDirectory` and `ExecStart` are pinned to `/opt/bims-capture-agent`. Rather than copying files, symlink to the home checkout so `git pull` updates the live agent.

```bash
sudo ln -s /home/<user>/bims-capture-agent/services/bims-capture-agent /opt/bims-capture-agent
sudo chmod o+x /home/<user>
```

The `chmod o+x` lets the `bims` user traverse the home directory to reach the agent files. If `ls -la /opt/bims-capture-agent/.venv/bin/python` doesn't show the python binary readable + executable by other, run `sudo chmod -R o+rX /home/<user>/bims-capture-agent`.

### 6.3 Fix env-file permissions

`setup-station.sh` installed `/etc/bims/station.env` with mode `0600 root:root` because the `bims` group didn't exist yet. Now it does — grant read access:

```bash
sudo chown root:bims /etc/bims/station.env
sudo chmod 0640 /etc/bims/station.env
```

### 6.4 Install + enable + start the unit

```bash
sudo cp /opt/bims-capture-agent/bims-capture-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now bims-capture-agent
```

`enable --now` does both: enables on-boot startup AND starts the service immediately.

### 6.5 Verify it's healthy

```bash
sudo systemctl status bims-capture-agent --no-pager
sudo journalctl -u bims-capture-agent -n 30 --no-pager
```

Look for:
```
Active: active (running)
INFO bims-capture-agent: starting bims-capture-agent v0.1.0 on 0.0.0.0:8765
INFO bims-capture-agent.camera: camera opened: 1280x720 native, target 1280x720 @ 15 fps
INFO bims-capture-agent: camera ready
INFO bims-capture-agent.scanner: scanner reading from /dev/input/event5 (USBScn Chip USBScn Module)
```

You may see a cosmetic warning `Invalid URL, ignoring: docs/prds/PI-CAPTURE-STATION.md` — that's systemd parsing the `Documentation=` field's space-separated values as two URLs and rejecting the relative path. Harmless.

If you see `STATION_JWT_SECRET is empty — rejecting all /ws connections`, the env file isn't being loaded or the `bims` user can't read it (Phase 6.3 didn't take).

**Verification check #6:** from the laptop:
```
curl.exe -s https://<pi-cv-name>.<tailnet>.ts.net/health
```
Returns JSON with `camera_ok: true`, `scanner_ok: true`.

### 6.6 Day-to-day operations

| Operation | Command |
|---|---|
| Tail live logs | `sudo journalctl -u bims-capture-agent -f` |
| Last N log lines | `sudo journalctl -u bims-capture-agent -n 50 --no-pager` |
| Restart agent | `sudo systemctl restart bims-capture-agent` |
| Stop agent | `sudo systemctl stop bims-capture-agent` |
| Start agent | `sudo systemctl start bims-capture-agent` |
| Disable on boot | `sudo systemctl disable bims-capture-agent` |
| Update code | `cd ~/bims-capture-agent && git pull origin bims-capture-agent && sudo systemctl restart bims-capture-agent` |
| Inspect unit | `sudo systemctl cat bims-capture-agent` |

If you change the `.service` file itself, run `sudo systemctl daemon-reload` before `restart`.

---

## Phase 7 — End-to-end test on /capture

Open `/capture` on BIMS in a browser. In the **Station** dropdown, pick "CV station test 1".

You should see:
- The local-camera placeholder disappear
- A live video stream from the Pi's USB camera
- The agent log gain lines: `ws connect ... operator=...`, `pc state -> connected`, ICE `SUCCEEDED`

If the stream is dark, the camera LEDs may be off — physically check.

**Verification check #7:** scan a barcode at the Pi's scanner. The barcode value should fire as a scan event into the `/capture` page (logged on Pi as a scan, surfaced in BIMS as cartridge context).

---

## First-time scanner setup (separate from Pi setup)

The Waveshare GW-Barcode ships in single-trigger / induction mode by default. For `/capture` to work, set it to **Continuous Mode**.

This is hardware-level configuration — you scan special config barcodes from the Waveshare user manual. **Plug the scanner into any computer with a display.** Open the manual:

https://files.waveshare.com/wiki/Barcode-Scanner-Module/Barcode_Scanner_Module_Setting_Manual_V2.1.pdf

Scan in this order:
1. **Enable Setup Code Function** (near start of configuration chapter)
2. **Continuous Mode** (in Working Mode / Reading Mode section)
3. **Same Code Read Delay = 0ms** (optional — lets the scanner re-read the same code immediately)
4. **Save Current Setting as User Default Setting**

Each successful scan beeps once. After this, the scanner remembers continuous mode across power cycles. The trigger button toggles continuous scanning on/off.

---

## Known failure modes

### "Could not start video source" on /capture

**Symptom:** red error text in the camera panel, no video element in DOM.
**Cause:** the page tries local camera on mount, fails (laptop has no webcam), sets `cameraError`. Until commit `f1109e8b`, this error wasn't cleared when switching to a remote station, so the video element never rendered.
**Fix:** ensure you're on `bims-capture-agent` commit `f1109e8b` or later. If you are, pick the Pi station from the dropdown — the error clears automatically.

### Video element renders, stream is black, no errors

**Symptom:** black panel, `getVideoTracks()[0].muted === true`, no `RTCInboundRtpVideoStream` in `chrome://webrtc-internals`.
**Cause:** aiortc's singleton camera track ends up in a state where new peer connections negotiate cleanly but no RTP flows. Happens after multiple page refreshes / station-switches accumulate stale peer connections on the agent.
**Workaround:** **restart the agent.** `Ctrl+C` the agent process, re-run `sudo .venv/bin/python agent.py`, refresh `/capture`, re-select the Pi station. Stream resumes.
**Root cause / proper fix:** needs work in `agent.py`'s `teardown_pc` to properly release track subscriptions, OR change `addTrack` ordering relative to `setRemoteDescription`. Coordinate with Jacob.

### Vercel `/capture` returns 500 with "window is not defined"

**Cause:** stale Vercel preview deploy (older commit on the branch). Was a real SSR bug on early commits, resolved on the latest `bims-capture-agent` deploy.
**Fix:** use the **branch-alias URL** (no build hash in the URL), which always points at the latest deploy. Find it in Vercel dashboard → Deployments tab.

### `evtest: error reading: No such device` after replug

**Cause:** the scanner re-enumerates as a new `/dev/input/eventN` each time it's unplugged (event5 → event6 → event7…).
**Fix:** use the persistent symlink instead of the event node:
```bash
sudo evtest /dev/input/by-id/usb-USBScn_Chip_USBScn_Module_*-event-kbd
```

### `tailscale serve` returns 502 Bad Gateway

**Cause:** TLS terminator on `:443` is up but the agent on `:8765` isn't listening.
**Fix:** SSH to Pi, check the agent process. If it's not running, restart it. Verify with `ss -tlnp | grep 8765` (should show a LISTEN line).

### Browser console: `WebSocket connection to 'wss://...' failed`

**Cause:** Tailscale serve isn't configured (no `:443` listener), OR the agent crashed.
**Fix:**
1. Check `tailscale serve status` — should show the proxy mapping. If empty, re-run `sudo tailscale serve --bg --https=443 http://localhost:8765`.
2. Check the agent is running.

### `setup-station.sh: line 48: uuidgen: command not found`

**Fix:** `sudo apt install -y uuid-runtime`, then re-run `setup-station.sh`.

### Sourcing `/etc/bims/station.env` from bash errors with `command not found`

**Cause:** the wizard writes values unquoted. `STATION_NAME=CV station test 1` parses as a variable assignment of `STATION_NAME=CV` followed by a command `station test`, which fails.
**Fix:** don't source it from bash. The agent uses `python-dotenv` which parses unquoted values correctly. If you really need bash to source it, edit the file and quote the value: `STATION_NAME="CV station test 1"`.

### `Connection closed by <pi-ip> port 22` during SSH login

**Cause:** SSH's MaxAuthTries (default 6) exceeded — usually mistyped passwords.
**Fix:** wait 10 seconds, reconnect. Type the password slowly — SSH password prompts don't echo any characters, which is a frequent source of mistyping.

### Tailscale Funnel / Serve missing HTTPS

**Cause:** tailnet doesn't have HTTPS Certificates enabled.
**Fix:** in Tailscale admin → DNS settings, enable "HTTPS Certificates" (free for all tailnets).

---

## Recovery: get back to a known-good state

If something breaks (rebooted Pi, network changed, agent died, env edited by accident), this gets you back to working video:

1. **Confirm Tailscale is up on the Pi**
   ```bash
   tailscale status
   ```
   Pi should appear with its tailnet IP. If not: `sudo tailscale up`.

2. **Confirm tailscale serve is configured**
   ```bash
   tailscale serve status
   ```
   Should show `https://<pi-cv-name>.<tailnet>.ts.net → http://localhost:8765`.
   If empty: `sudo tailscale serve --bg --https=443 http://localhost:8765`.

3. **Confirm env file is intact**
   ```bash
   sudo cat /etc/bims/station.env
   ```
   Should have `STATION_ID`, `STATION_NAME`, `STATION_TOKEN`, `BIMS_URL`, `STATION_JWT_SECRET`, `PORT=8765`. If `STATION_JWT_SECRET` is missing, you need to re-register with BIMS (Phase 4).

4. **Confirm hardware is detected**
   ```bash
   lsusb | grep -E "Camera|USBScn"
   ls /dev/video0 /dev/input/by-id/usb-USBScn*
   ```
   If either is missing, replug the USB cable.

5. **Check the systemd service**
   ```bash
   sudo systemctl status bims-capture-agent --no-pager
   ```
   If `Active: active (running)` and the log lines show camera + scanner ready, you're done. If it's `failed` or stopped, restart it:
   ```bash
   sudo systemctl restart bims-capture-agent
   sudo journalctl -u bims-capture-agent -n 30 --no-pager
   ```
   The last command surfaces the startup error if it failed.

6. **Verify from laptop**
   ```powershell
   curl.exe -s https://<pi-cv-name>.<tailnet>.ts.net/health
   ```
   Returns JSON with `camera_ok: true`, `scanner_ok: true`.

7. **Open /capture, pick the station, see the stream.** If the video panel is black with no error after ~5 seconds: known issue, restart the agent (`sudo systemctl restart bims-capture-agent`).

---

## Quick-reference checklist

Day-to-day "is everything working?" checks. Run from the laptop:

```powershell
# Tailscale reaches the Pi
tailscale ping <pi-cv-name>

# Agent is responding through HTTPS proxy
curl.exe -s https://<pi-cv-name>.<tailnet>.ts.net/health

# Both peripherals healthy
curl.exe -s https://<pi-cv-name>.<tailnet>.ts.net/health | findstr "true"
```

Two `true` matches (for `camera_ok` and `scanner_ok`) means the agent is alive and seeing both devices.

---

## Things not yet done (planned phases)

- **Self-registration** — Phase 5 of `setup-station.sh` is planned to automate the BIMS registration step. Today it's manual via DevTools fetch, and the returned `STATION_JWT_SECRET` is hand-pasted into `/etc/bims/station.env`.
- **Cloudflare Tunnel install** — Phase 5 placeholder in `setup-station.sh`. Tailscale Serve covers the current "tailnet-only" topology; Cloudflare Tunnel would be needed if BIMS is required to call into the Pi from Vercel (it can't reach tailnet IPs).
- **LED control** (Phase 4 of agent PRD) — `led.py` not yet implemented.
- **BIMS admin UI for stations** — no `/admin/stations` route exists; registration, listing, and de-provisioning all happen via API or direct Mongo today.
- **Robot arm support** (planned, no PRD scope yet).
