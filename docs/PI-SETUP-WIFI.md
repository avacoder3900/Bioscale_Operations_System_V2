# Pi Capture Station — WiFi Setup Guide

**Audience:** Whoever is setting up a new Raspberry Pi capture station physically.
**Time:** ~15 minutes per Pi if everything is on hand.
**Related:** `docs/prds/PI-CAPTURE-STATION.md`, `docs/prds/PI-CAPTURE-STATION-BOM.md`

This document covers **only the network setup** — getting a fresh Pi onto the manufacturing WiFi and reachable over SSH. Application-level configuration (registering the station with BIMS, Cloudflare Tunnel, the capture agent itself) happens in a separate runbook after the Pi is on the network.

---

## What you need

| Item | Notes |
|---|---|
| Raspberry Pi 5 (4 GB) | Brand-new, in the box. Power supply, case, active cooler all unboxed and ready. |
| microSD card (32 GB+, Class 10/A2) | Blank or wipeable. |
| microSD reader for your computer | Built into many laptops; USB dongle works if not. |
| A computer (Windows / Mac / Linux) | The one you're sitting at right now is fine. |
| Internet on that computer | Needed to download the OS image and the imaging tool. |
| The manufacturing WiFi SSID + password | Get this from IT if you don't already have it. |
| (Path B only) Ethernet cable | Cat5e or Cat6, ~6 ft. |
| (Path B only) An Ethernet port on your computer | Many laptops need a USB-to-Ethernet dongle. |

You'll also want a notepad. Each Pi needs a unique hostname like `cap-pi-1`, `cap-pi-2`, etc. Write down which one corresponds to which physical station.

---

## Pick a path

You have two ways to get WiFi onto a fresh Pi. Pick whichever fits your situation:

| Path | When to use | Time |
|---|---|---|
| **Path A — Pre-baked WiFi (recommended)** | You have the SD card in hand and your computer's microSD reader. WiFi creds are written to the card BEFORE first boot. | ~10 min |
| **Path B — Ethernet bootstrap** | The Pi is already flashed but never had WiFi configured, OR Path A's pre-bake didn't take. You SSH in over Ethernet and configure WiFi manually. | ~15 min |

---

## Path A — Pre-baked WiFi (recommended)

This is the easiest. You tell Raspberry Pi Imager your WiFi details when flashing the SD card; the Pi joins the network automatically on first boot.

### A1. Download Raspberry Pi Imager

- Go to **https://www.raspberrypi.com/software/**
- Download the Imager for your OS (Windows / macOS / Ubuntu).
- Install and launch it.

### A2. Insert the SD card into your computer

- Plug the microSD into your reader.
- Confirm your computer sees it (a drive letter on Windows, a Finder volume on Mac).
- **Warning:** flashing will wipe everything on the card. Don't plug in your personal USB stick by accident.

### A3. Choose the OS and the card

- Click **CHOOSE DEVICE** → "Raspberry Pi 5".
- Click **CHOOSE OS** → "Raspberry Pi OS (other)" → **"Raspberry Pi OS Lite (64-bit)"**. We don't need the desktop — the Pi runs headless.
- Click **CHOOSE STORAGE** → pick your microSD card (be sure of the drive letter).

### A4. Open the advanced settings (the most important step)

- Click **NEXT**, then when it asks "Would you like to apply OS customisation settings?" click **EDIT SETTINGS**.
  (Newer versions of Imager call this the "OS Customisation" panel and may pop it up automatically.)

In the panel that opens:

- **Hostname:** `cap-pi-1` (or whatever number this station is — give each Pi a unique name).
- **Username and password:**
  - Username: `bims`
  - Password: pick a strong one. Write it down somewhere safe — you'll need it for SSH later.
- **Configure wireless LAN:** **CHECK THIS BOX.**
  - SSID: your manufacturing WiFi network name
  - Password: the WiFi password
  - Wireless LAN country: `US` (or wherever you are; affects which channels are legal)
- **Set locale settings:** time zone (e.g., `America/Chicago`), keyboard layout (`us`).
- **Services tab:** **CHECK "Enable SSH"** → choose **"Use password authentication"** for now (we'll add key-based later).

Click **SAVE**, then back on the warning dialog click **YES** to apply settings, then **YES** again to confirm "you'll erase everything on the card."

### A5. Wait for the flash to finish

Takes 3-10 minutes depending on your card speed. The Imager will verify the write at the end. Don't unplug.

When it says "Write Successful — You can now remove the SD card," do that.

### A6. Boot the Pi

- Slide the SD card into the Pi.
- Install the active cooler if you haven't (it clips on top of the CPU).
- Close the case.
- Plug in the USB-C power supply.
- **Wait 2-3 minutes.** First boot expands the filesystem and joins WiFi; it takes longer than later boots.

### A7. Verify the Pi is on WiFi

On your computer, in a terminal (PowerShell on Windows, Terminal on Mac):

```
ping cap-pi-1.local
```

- If you get replies, **you're done with Path A.** SSH in next:
  ```
  ssh bims@cap-pi-1.local
  ```
  Use the password you set in A4.

- If `cap-pi-1.local` doesn't resolve:
  - Wait another 60 seconds and try again — mDNS sometimes takes a moment.
  - Try the IP directly. Log into your router's admin page, find the device list, look for `cap-pi-1`. SSH to that IP: `ssh bims@<ip>`.
  - If you still can't reach it: **fall through to Path B** to fix the WiFi config manually.

---

## Path B — Ethernet bootstrap (fallback)

Use this when Path A didn't take, or when you have a Pi that was flashed without WiFi configured.

### B1. Wire it up

- Plug an Ethernet cable from the Pi's Ethernet port to your computer (or to a router/switch that your computer is on).
- Plug in USB-C power to the Pi.
- Wait 60-90 seconds for it to boot.

### B2. Find the Pi on the network

On your computer:

```
ping cap-pi-1.local
```

If that doesn't work and you connected the Pi directly to your computer (not through a router):

- **Windows:** open Settings → Network → Ethernet → make sure "Internet Connection Sharing" is on so the Pi gets an IP from your computer. Look in `arp -a` to find the Pi's IP.
- **Mac:** open System Preferences → Sharing → enable "Internet Sharing" from WiFi to Ethernet. Look in `arp -a`.

Or just put the Pi on the same switch/router as your computer — easier.

### B3. SSH in

```
ssh bims@cap-pi-1.local
```

If the username/password isn't `bims` / whatever-you-set, use the default that was baked into the image (usually `pi` / `raspberry` for vanilla Raspberry Pi OS, but that's discouraged for production).

### B4. Configure WiFi from the command line

Once you're SSH'd in:

```bash
sudo raspi-config
```

A blue text menu appears. Navigate:

- **1 System Options** → **S1 Wireless LAN**
- Pick your country (US).
- Enter your SSID.
- Enter your WiFi password.
- Pick **Finish** to exit.

Verify:

```bash
iwconfig wlan0
```

You should see an SSID listed (not `off/any`). And:

```bash
ip addr show wlan0
```

You should see an `inet 192.168.X.X` line — that's the Pi's WiFi IP.

### B5. Confirm WiFi works without Ethernet

While still SSH'd in:

```bash
sudo dhclient -r eth0
```

This releases the Ethernet lease. Then unplug the Ethernet cable physically. Your SSH session will hang (because you SSH'd over Ethernet). That's expected.

From your computer, try:

```
ssh bims@cap-pi-1.local
```

If that works over WiFi, **you're done.** Power-cycle the Pi once to make sure it comes back up on WiFi by itself.

---

## How to verify it's really working

Run these from your computer:

```bash
# Pi is reachable
ping -c 3 cap-pi-1.local

# Can SSH
ssh bims@cap-pi-1.local "hostname && iwconfig wlan0 | grep ESSID && ip route | grep default"
```

Expected output:
- Hostname: `cap-pi-1`
- WiFi SSID: shows your manufacturing network's name (not `off/any`)
- Default route: points to your network's gateway (a `192.168.X.X` or similar)

If all three look right, the Pi is good to hand off to whoever's installing the capture agent next.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `ping cap-pi-1.local` says "host unreachable" right after boot | Pi still booting first-time setup | Wait 3 full minutes from power-on. First boot is slow. |
| Can ping the Pi but `ssh` says "Permission denied" | Wrong password | The password you set in A4 (or the default if you skipped that). Try again carefully. |
| `ssh` says "Connection refused" | SSH not enabled on the image | Re-flash with Path A and **check "Enable SSH"** in the Services tab. |
| Pi joins WiFi but `ping` to internet (e.g. `ping google.com`) fails | DNS issue, or restricted manufacturing VLAN | Get IT involved — the Pi may need to be on a specific VLAN or have a firewall exception. |
| WiFi drops every few minutes | 2.4 GHz channel interference, or weak signal | Try 5 GHz only by editing `/etc/wpa_supplicant/wpa_supplicant.conf` to set `freq_list=5180 5200 ...`. Or move closer to the AP. |
| `iwconfig` shows ESSID is correct but no IP | DHCP not responding | `sudo dhclient -v wlan0` to force a renew. Check `journalctl -u dhcpcd -n 50` for errors. |
| First-time `ssh` complains about "host key has changed" | You're re-flashing a Pi at the same hostname | On your computer, run `ssh-keygen -R cap-pi-1.local` and try again. |
| Pi 5 won't boot at all (just red LED, no green) | Power supply not PD-compliant | Use the official Pi 5 27 W USB-C PSU. Generic 5V/3A supplies cause this. |

---

## Reset / start over

If something is badly mis-configured and you just want to redo it:

1. Power off the Pi (unplug).
2. Pop the SD card out.
3. Re-flash via Path A (it's destructive — wipes the card).
4. Boot fresh.

Wiping the SD card takes a few minutes but is usually faster than trying to fix a tangled config.

---

## Next steps

Once the Pi is on WiFi and SSH works:

1. The Pi is ready for the **`setup-station.sh` script** (covered in the next runbook — coming with Phase 5 of `PI-CAPTURE-STATION.md`).
2. That script installs `cloudflared`, registers the station with BIMS, and starts the `bims-capture-agent` service.
3. You should be able to see the station appear in BIMS `/cv/stations` within a minute of running it.

If you're setting up several Pis at once, you can fly through Path A for each one — just change the hostname (`cap-pi-2`, `cap-pi-3`, …) when you re-flash.
