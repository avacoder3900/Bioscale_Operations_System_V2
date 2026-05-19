# BOM: Pi-Hosted Remote Capture Station (per station)

**Date:** 2026-05-19
**Status:** Draft v1
**Related:** `docs/prds/PI-CAPTURE-STATION.md`
**Purpose:** Itemized parts list for procurement — one full station. Prices are approximate USD ranges as of mid-2026; refresh before ordering.

---

## Summary

| Phase | Subtotal (approx) |
|---|---|
| **Core (Phases 1–3 MVP)** — Pi + camera + scanner + power + cables | **$130 – $190** |
| Phase 4 — UV LED + safety + driver | $80 – $150 |
| Phase 7+ — Robot arm hardware (future, separate BOM) | TBD |
| **Total core station** | **$130 – $190** |

---

## Phase 1–3 Core (required for MVP)

### Compute

| Item | Specification | Qty | Approx cost | Vendor candidates | Notes |
|---|---|---|---|---|---|
| **Raspberry Pi 5 — 4 GB** | Model B, BCM2712, onboard WiFi (2.4/5 GHz dual-band) + BT 5.0 + Gigabit Ethernet | 1 | $60 | raspberrypi.com / PiShop / Adafruit / Digi-Key / CanaKit | 8 GB ($80) only worth it if Phase 7 robot-arm pathfinding runs on-Pi. 4 GB is fine for WebRTC + jsQR + GPIO. Pi 4 (4 GB, $45) also works if procurement difficulty pushes you off Pi 5. |
| **Pi 5 official USB-C PSU** | 27 W, 5.1 V / 5 A, USB-C PD | 1 | $12 | Same as Pi vendor | Pi 5 needs PD-compliant supply; cheaper 5V/3A supplies trigger undervoltage warnings and current-limit USB ports (will break the camera). |
| **Pi 5 Active Cooler** | Official 1× fan + heatsink, PWM-controlled | 1 | $5 | Same | Pi 5 thermal-throttles within minutes under continuous WebRTC encode. Skip at your peril. |
| **microSD card** | 32 GB, SanDisk Extreme A2 OR Samsung Pro Endurance | 1 | $10 | Amazon / Newegg | A2 spec recommended (random-IO performance matters for a long-running service). Endurance variant trades capacity for write-cycle longevity if you'd rather. |
| **Pi 5 case** | Official Pi 5 case OR generic aluminum enclosure with cooler cutout | 1 | $10 – $20 | Same | Manufacturing floor needs dust/debris protection. Aluminum enclosure doubles as a heatsink. |

**Compute subtotal:** $97 – $112

### Capture peripherals (already on hand)

| Item | Specification | Qty | Cost | Notes |
|---|---|---|---|---|
| USB camera | Same model used at `/capture` workstation today | 1 | (already owned) | Linux UVC class — most USB cams work out of box. **Confirm exact model + run `lsusb` on a test Pi** before committing the fleet. |
| Waveshare GW-Barcode scanner | USB HID keyboard mode, VID `0218`:PID `0210`, Enter suffix | 1 | (already owned) | Confirmed compatible — see `reference_waveshare_gw_barcode_scanner.md` memory + the test we already ran. |

**Peripherals subtotal:** $0 (using existing inventory)

### Wiring / power distribution

| Item | Specification | Qty | Approx cost | Notes |
|---|---|---|---|---|
| **Powered USB 3.0 hub** | 4-port (or more), separate 5V/3A power input | 1 | $20 – $30 | Anker, Sabrent, or similar. The Pi 5's USB ports are power-limited; an external-powered hub keeps the camera + scanner stable, leaves a port free for the robot arm later. |
| **USB-A → USB-A cables** | 3 ft, USB 2.0 or 3.0 (USB 3.0 for camera if it supports it) | 2 | $5 each | One for camera, one for scanner. Hub-to-Pi link uses one of the hub's included cables. |
| **Ethernet cable** | Cat6, 6 ft | 1 | $5 | Used **only** for initial WiFi-config session over SSH. Once provisioned, unplug. (Per your call: Pi runs on WiFi in production.) |
| **Cable management** | Velcro ties or split-loom tubing | — | $5 | Manufacturing-floor presentability. |

**Wiring subtotal:** $40 – $50

### Network (one-time, infrastructure)

| Item | Specification | Qty | Cost | Notes |
|---|---|---|---|---|
| **Cloudflare Tunnel** | `cloudflared` daemon on each Pi → free Cloudflare account → DNS record per Pi (`cap-pi-1.<yourdomain>`) | — | $0 (free tier) | Required for TLS strategy decided in PRD §8. Each Pi gets a stable HTTPS URL without self-signed cert dance. You already use Cloudflare for R2 storage. |
| **DNS records** | Wildcard or per-Pi CNAME under an existing Cloudflare-managed domain | per station | $0 (within existing zone) | If you don't have a domain managed by Cloudflare, this becomes a $10/yr domain registration. |

---

## Phase 4 (optional — UV illumination)

| Item | Specification | Qty | Approx cost | Notes |
|---|---|---|---|---|
| **IO Rodeo 365 nm Radial LED Board** | https://iorodeo.com/products/365nm-radial-led-board — **interface still to be verified from datasheet** | 1 | ~$70 (typical IO Rodeo board) | Vendor returned 503 at PRD time; verify electrical interface (TTL trigger vs USB serial vs I2C) before ordering. If TTL, need a small driver board between Pi GPIO and the LED PSU. |
| **External 12 V supply for LED** | (only if LED isn't USB-powered) | 1 | $10 – $15 | Match LED board's voltage spec. |
| **GPIO control wiring** | 22 AWG jumpers + screw terminal block OR MOSFET driver board | — | $5 – $10 | Only if LED uses TTL trigger; skip if it's USB-controlled. |
| **UV-safety eyewear (365 nm)** | UV-blocking lab safety glasses (e.g., Uvex S0360X or equivalent) | 2 minimum | $15 each | **Required.** 365 nm is UVA; sustained eye exposure is harmful. Each operator at the station gets a pair, plus a spare. |
| **UV warning placard** | "UV ON when illuminated" sign | 1 | $5 | Mount on the station's fixture. Visible from operator position. |
| **Physical interlock switch (recommended)** | Momentary push-button, NO contact, panel-mount | 1 | $10 | Wires to a Pi GPIO input. UI sends `led:on` but the LED only actually energizes while the operator is holding the physical button. Prevents remote click from blasting UV across the room. Software in Phase 4 should support this as a safety mode. |

**Phase 4 subtotal:** $115 – $150 (with safety interlock + 2 pairs of eyewear)

---

## Phase 7+ (forward-compat — robot arm, future)

Reserved space, not yet specified. Captured as forward-compat in PRD §13 only. Expected items when the time comes:

- Servo-driven arm (e.g., SO-ARM101 per existing `project_robot_arm_workspace`)
- Power supply for the arm
- USB-to-servo-bus adapter (CH343 + half-duplex transceiver per existing robot-arm work)
- Gripper or end-effector for cartridge handling
- Optional: vacuum pickup / pneumatics

The Pi 5 has enough USB ports and CPU headroom to host the arm controller alongside the capture agent — confirmed in PRD §13.

---

## Tools / supplies (one-time per facility)

These don't repeat per station — buy once for the fleet:

| Item | Approx cost | Notes |
|---|---|---|
| SD card flasher (USB) | $10 | Many computers have a built-in slot; only needed if yours doesn't. |
| Raspberry Pi Imager (free software) | $0 | https://www.raspberrypi.com/software/ |
| Multimeter | $20 | Verify PSU voltage at the Pi's input pins when troubleshooting brown-outs. |
| Spare microSD card | $10 | Cold spare for swap recovery. |

---

## Reordering / volume notes

- **Fleet target.** PRD assumes each manufacturing step (wax-fill, reagent-fill, sealing, oven, QC) may eventually have its own station. Plan for 5–8 stations at full deployment. Buy 1 of everything for the pilot; expand from there.
- **SD card image.** Build one master image (Phase 5), clone it to all SD cards. Per-station config injected via `setup-station.sh` rather than per-image.
- **Volume discount.** PiShop and Adafruit both offer modest volume discounts above 5 units of the same SKU. Worth a single PO if you're committing to >3 stations.

---

## Procurement checklist

- [ ] Confirm USB camera model is the same one currently on the operator workstation (run `lsusb` while it's plugged in).
- [ ] Verify IO Rodeo 365 nm LED interface (datasheet) before adding it to the Phase 4 order.
- [ ] Confirm Cloudflare account access + a domain managed by Cloudflare (or budget a $10/yr domain reg).
- [ ] Confirm the manufacturing WiFi network's SSID + password + DHCP range; pick a static-IP block for the Pi fleet if your network team prefers.
- [ ] Decide on enclosure aesthetics (consumer plastic vs aluminum DIN-rail) before ordering cases.
- [ ] Buy 2 pairs of UV safety eyewear with the first Phase 4 station.
