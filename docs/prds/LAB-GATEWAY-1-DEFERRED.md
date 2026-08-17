# LAB-GATEWAY-1 — Consolidated lab gateway (DEFERRED)

**Date:** 2026-08-17 · **Status:** Deferred by Jacob (2026-08-17) · **Parent:** `OT2-TAILNET-0-PLAN.md`

## What this would be

One always-on lab-side process (on the existing lab Mac via launchd, or a
dedicated Mac mini / N100 mini-PC / Pi 5 on the UPS) that:

- runs the OT-2 command relay for **all** robots (relaying `kind:'http'` to
  each robot's `:31950` over the LAN) instead of one daemon per robot's Pi;
- hosts a **print-job queue consumer** pushing ZPL to the Zebra ZT230 over
  TCP 9100, so MCP/agent/cron-initiated label printing works without Browser
  Print on a PC (`docs/ZEBRA-ZT230-BARCODE-PRINTING.md` "future" path);
- is the natural home for future lab-side services (temperature probes,
  capture-station admin, robot arm).

## Why we're not doing it now

- The gantry barcode scanner is USB on each OT-2, so an on-robot component
  is unavoidable for sweeps/deck-scan unless the scanner is moved to a
  serial-over-Ethernet adapter (Moxa NPort / USR-TCP232, ~$40) — extra
  hardware + a change to a working flow.
- Jacob is fine leaving the OT-2 Pis modified; the per-robot deploy cost is
  tolerable. TAILNET-1/2 deliver the "feels snappy" win without a gateway.
- The lab Mac is a workstation, not a boring always-on box; running a
  production service on it invites sleep/reboot/borrowing incidents.

## When it becomes worth it (any one of these)

- Unattended / agent-driven label printing is wanted (MCP "print 20 labels").
- Per-robot bridge deploys become a recurring pain (OS updates wiping `/data`).
- A fourth robot or another lab-side device shows up.
- Server-initiated robot control from Vercel needs to be fast (would then also
  need a Cloudflare Tunnel + Access or Tailscale Funnel with token auth — a
  deliberate inbound-path decision, see PLAN §Decisions 5).

## If/when picked up

- Hardware: fanless N100 mini-PC or Mac mini, wired Ethernet, on the UPS,
  tagged `tag:lab-gateway` on the tailnet.
- Software: reuse `scripts/ot2-bridge.py` command loop with a `robots[]`
  config; new `PrintJob` model + `/api/agent/print/poll` + consumer; the ZPL
  builder in `src/lib/zebra/cartridge-label-zpl.ts` and the batch lifecycle in
  `src/lib/server/services/barcode-print-batch.ts` are already medium-agnostic.
- Keep the on-robot piece as a thin serial shim or eliminate it with a serial
  adapter.
