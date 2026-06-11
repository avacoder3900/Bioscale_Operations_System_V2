# Lab Mac Runbook — OT-2 Bridge Go-Live (2026-06-11)

Checklist for the Mac on the lab network. Goal: get B07 running the new
ot2-bridge daemon, teach its deck-barcode position, and verify the new
one-button Start Run works from the **production URL**.

Everything here ships on `master`/`main` as of `61aca89`. Detailed install
commands live in `scripts/OT2-BRIDGE-DEPLOYMENT.md` — this is the ordered
checklist with the gotchas.

---

## 0. Prep on the Mac (5 min)

- [ ] `git pull` in the repo (both trunks are at the same commit; either is fine).
- [ ] Confirm `.env` has `MONGODB_URI` and `AGENT_API_KEY` (you'll copy the
      key to the robot).
- [ ] If you want a local dev server for the teach step (recommended —
      direct robot calls, no bridge lag):
      `set -a; source .env; set +a; npm run dev`
      (plain `npm run dev` 500s — it doesn't load `.env`; long-standing gotcha.)

## 1. Deploy ot2-bridge to B07 (~15 min)

Full commands: `scripts/OT2-BRIDGE-DEPLOYMENT.md`. The short version:

- [ ] `ssh root@<B07 ip>` (same key you used for the scanner bridge).
- [ ] **Stop the old scanner bridge first** — it's running via
      `nohup ./run.sh &` in `/data/scanner-bridge` (no systemd). Find and
      kill it: `ps aux | grep scanner-bridge` → `kill <pid>`.
- [ ] `mkdir -p /data/ot2-bridge`; copy from the Mac:
      `scp scripts/ot2-bridge.py root@<B07>:/data/ot2-bridge/`
      `scp scripts/ot2-bridge-run.sh root@<B07>:/data/ot2-bridge/run.sh`
      `chmod +x /data/ot2-bridge/run.sh`
- [ ] Create `/data/ot2-bridge/.env`:
      ```
      BIMS_BASE_URL=https://bioscale-operations-system-mongodb.vercel.app
      BIMS_AGENT_API_KEY=<AGENT_API_KEY from the Mac .env>
      BRIDGE_DEVICE_ID=ot2-b07-bridge
      SCANNER_DEVICE_ID=ot2-b07-scanner
      SCANNER_SERIAL_PORT=/dev/scanner
      ```
      ⚠️ The OLD scanner-bridge `.env` on B07 has `BIMS_BASE_URL` pointed at
      this Mac's LAN IP (`http://172.16.28.173:5176`) from the May perf
      testing — do NOT copy that value. The bridge must point at Vercel.
      (If `/dev/scanner` doesn't exist, the udev rule is missing — use
      `/dev/ttyACM0`.)
- [ ] Python deps should already exist from the scanner bridge
      (`pyserial`, `requests`); if not, see the `--user` + `/root/.local`
      symlink quirk in the deployment doc.
- [ ] **Foreground smoke test**: `cd /data/ot2-bridge && sh run.sh` — watch
      for the startup banner, a heartbeat POST success, and no serial errors.
      Ctrl-C when satisfied.
- [ ] **Systemd** (so it survives reboot — the scanner bridge never had this):
      remount rw if needed (`mount -o remount,rw /`), then
      `scp scripts/ot2-bridge.service root@<B07>:/etc/systemd/system/`
      `systemctl daemon-reload && systemctl enable --now ot2-bridge`
      `journalctl -u ot2-bridge -f` to tail logs.

## 2. Verify the bridge is alive (2 min)

- [ ] On the **production URL**: `/manufacturing/cart-mfg/opentron-control/scanner-test?deviceId=ot2-b07-scanner`
      should show a recent heartbeat (the unified daemon heartbeats as
      `ot2-b07-bridge` AND services the old scanner deviceId for triggers —
      the scanner-test trigger button should still round-trip a scan).
- [ ] Robot health: the robots page should show B07 online *from the
      production deploy* (that's the bridge relaying `/health`).

## 3. Teach B07's deck-barcode position (~5 min)

- [ ] Physical check first: the deck's barcode label must be on a surface
      the gantry scanner can point at (facing up, within travel + focal
      range — same constraints as the slot barcodes). If DECK labels are on
      an edge the scanner can't see, stick a duplicate label flat on a top
      corner.
- [ ] Scanner-positions page → B07's default set ("Barcode Locations") →
      new **Deck Barcode** section under the slot grid → open maintenance
      run, jog over the label, Save Deck Position, then test-scan to confirm
      it reads. (Do this from the local dev server for snappy jogging, or
      from production — jog works over the bridge, just laggier.)

## 4. Test the new one-button flow from PRODUCTION (~10 min)

- [ ] `/manufacturing/cart-mfg/wax-filling` → pick B07 → Start Wax Filling
      Run → wax prep (lot dropdown → count → computed µL confirm).
- [ ] At the Load stage you should see the protocol Start Run panel with the
      orchestration checklist. Use **Test Mode** (checkbox above the panel)
      if you don't have real backed cartridges — unknown barcodes get
      synthesized server-side.
- [ ] Press Start Run and watch: deck scan ✓ → cartridge sweep (live slot
      N/24) ✓ → load ✓ → protocol start. Any failure auto-opens the
      "Manual scanning (fallback)" section — note what failed.

## 5. Only if time permits

- [ ] R04 / B14: their slot position sets are **verbatim clones of B07's
      coordinates and were never jog-verified** — jog-check before trusting
      auto-sweep there (likely re-teach column 0 + re-run
      `scripts/extrapolate-scanner-positions.ts`). Then repeat steps 1–3 on
      each (deviceIds `ot2-r04-*` / `ot2-b14-*`).
- [ ] Delete/disable the old `/data/scanner-bridge` autostart remnants on
      B07 so it can't resurrect after a reboot and fight for the serial port.

## Known limitations to keep in mind on the floor

- Protocol upload/deploy and the opentrons-clone pages are **localhost-only**
  (not bridged) — use the local dev server for those.
- Teach/jog over the bridge has ~0.5–1.5 s lag per jog — fine, but local dev
  feels better.
- If a sweep sits at "queued" and then errors with "bridge daemon did not
  pick up the sweep" — the daemon is down; check `journalctl -u ot2-bridge`.
