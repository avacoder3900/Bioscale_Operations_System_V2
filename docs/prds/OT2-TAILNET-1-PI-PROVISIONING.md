# OT2-TAILNET-1 — Put the OT-2 Pis on the tailnet (HTTPS front for :31950)

**Date:** 2026-08-17 · **Owner:** Jacob (lab) · **Status:** Approved · **Parent:** `OT2-TAILNET-0-PLAN.md`

## Goal

Each OT-2's internal Raspberry Pi joins the company tailnet and serves its
robot API over HTTPS at `https://<robot>.<tailnet>.ts.net/`, reachable only
from lab workstations. The existing `ot2-bridge.py` daemon is untouched.

## Facts to work from

- OT-2 = Raspberry Pi 3B+ (ARMv7/aarch64 kernel, 32-bit userland) running
  Opentrons' Buildroot OS. Root SSH via `docs/brevitest-opentrons-files-4-21/ot2_ssh_key`.
  Persistent storage is `/data` (where `/data/ot2-bridge/` already lives).
- robot-server listens on `:31950` (HTTP, no auth). Every request needs an
  `Opentrons-Version: *` (or specific) header.
- CV Pis are provisioned per `services/bims-capture-agent/RUNBOOK.md` Phase 2
  (`tailscale up --hostname … --ssh`) and Phase 5 (`tailscale serve --bg --https=443 http://localhost:8765`).
  Copy that pattern.
- Tailnet HTTPS certificates are already enabled (needed by the CV Pis).

## Steps (per robot; B07 first)

1. **Install** the static Tailscale build under `/data` (Buildroot has no
   package manager). Pick the arm build matching `uname -m`.
   ```
   mkdir -p /data/tailscale && cd /data/tailscale
   curl -fsSLO https://pkgs.tailscale.com/stable/tailscale_<ver>_arm.tgz   # or arm64
   tar xzf tailscale_*.tgz --strip-components=1
   ```
2. **Run `tailscaled`.** If `/dev/net/tun` is missing or the kernel lacks it,
   use userspace networking — outbound + `serve` still work in that mode:
   ```
   /data/tailscale/tailscaled --state=/data/tailscale/tailscaled.state \
     --socket=/data/tailscale/tailscaled.sock --tun=userspace-networking &
   ```
3. **Join** with the robot's slot as hostname and an ACL tag:
   ```
   /data/tailscale/tailscale --socket=/data/tailscale/tailscaled.sock up \
     --hostname=ot2-b07 --advertise-tags=tag:ot2 --ssh
   ```
   Approve in the admin console. Prefer a **pre-auth key** with `tag:ot2`
   scoped to the device so re-provisioning after an OS wipe is non-interactive.
4. **HTTPS front for the robot API:**
   ```
   /data/tailscale/tailscale --socket=… serve --bg --https=443 http://localhost:31950
   ```
   Result: `https://ot2-b07.<tailnet>.ts.net/health` → robot health.
5. **CORS check** (decides TAILNET-2's client shape):
   ```
   curl -si -X OPTIONS https://ot2-b07.<tailnet>.ts.net/runs \
     -H 'Origin: https://bioscale-operations-system-mongodb.vercel.app' \
     -H 'Access-Control-Request-Method: POST' \
     -H 'Access-Control-Request-Headers: opentrons-version,content-type'
   ```
   Expect `Access-Control-Allow-Origin: *` (robot-server ships permissive
   CORS). If not, add a tiny header-injecting reverse proxy on the Pi and
   point `serve` at it instead. Record the outcome in this doc.
6. **Boot persistence.** Add to the same mechanism that starts the bridge
   (`/data/ot2-bridge/run.sh` is launched by hand today — fix that here for
   both): a `/data/ot2-tailscale/run.sh` and, if Opentrons OS allows, a
   systemd unit under `/data/systemd/` or an entry in whatever they use for
   the bridge. Document exactly what was done in `scripts/OT2-BRIDGE-DEPLOYMENT.md`
   (new section "Tailscale") so an OS update recovery is a copy-paste.
7. **ACLs** (Tailscale admin console, `acls` policy file). Add and commit the
   diff to `docs/tailnet/acl.json` (new, kept in repo as documentation):
   ```json
   {
     "tagOwners": { "tag:ot2": ["autogroup:admin"], "tag:lab-workstation": ["autogroup:admin"] },
     "acls": [
       { "action": "accept", "src": ["tag:lab-workstation"], "dst": ["tag:ot2:443", "tag:ot2:22"] }
     ]
   }
   ```
   Tag the CV workstations / lab PCs `tag:lab-workstation`. Nothing else may
   reach `tag:ot2`. **Do not enable Funnel on robots.**
8. **Record in BIMS:** set `OpentronsRobot.directUrl = https://ot2-b07.<tailnet>.ts.net`
   (field added in TAILNET-2; until then note it here).

## Verification (per robot)

- [ ] `tailscale status` on a lab workstation lists `ot2-b07` online.
- [ ] `curl -s https://ot2-b07.<tailnet>.ts.net/health -H 'Opentrons-Version: *'` → JSON with `name`.
- [ ] Same curl from a node without `tag:lab-workstation` → connection refused/timeout.
- [ ] `ps aux | grep ot2-bridge` still running; BIMS shows a fresh heartbeat for `ot2-b07-bridge`.
- [ ] Reboot the robot: tailscaled + serve + bridge all come back without hands.
- [ ] CORS outcome recorded above.

## Rollout

B07 → verify TAILNET-2 against it → R04 → B14. Update
`docs/LAB-MAC-RUNBOOK-OT2-BRIDGE.md` post-update checklist to include
"tailscale status shows the robot; serve is on".

## Out of scope

Removing the bridge, moving the scanner, gateway box, Funnel.
