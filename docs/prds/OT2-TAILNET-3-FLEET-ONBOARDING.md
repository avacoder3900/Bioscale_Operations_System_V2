# OT2-TAILNET-3: Tailscale as the main BIMS↔OT-2 line — repeatable robot onboarding, B14 first

**Author:** Alejandro (via Claude Code)  **Date:** 2026-09-25  **Status:** Draft
**Priority:** P1. Every interactive robot action pays a Vercel→Mongo→long-poll round trip, and the approved fix (TAILNET-0/1/2) has sat unbuilt since 2026-08-17.
**Parent:** `OT2-TAILNET-0-PLAN.md` (its decisions stand). **Supersedes:** the rollout order in TAILNET-0/1 (B07 → R04 → B14 becomes **B14 → B07 → R04**) and the provisioning steps in TAILNET-1.
**Amends:** `OT2-TAILNET-2-DIRECT-CONTROL.md` (scope additions in §7.4).
**Target branch:** `feat/ot2-tailnet-fleet` (off master)

---

## 1. Problem Statement

BIMS reaches an OT-2 only through the Vercel command queue:

```
browser → Vercel route → Mongo Ot2BridgeCommand → robot's long-poll → robot API :31950
        ← browser poll ← Mongo result ←──────────── robot posts result
```

This works, but it is slow and ambiguous for the interactive actions (pause, resume, cancel, jog, status, health):
- A `GET /health` through the queue measured **B14 0.6 s, B07 0.9 s, R04 2.6 s** (progress.txt:7202).
- A missed poll cycle adds seconds.
- The "bridge slow" banner and the auto-resume races in `EmbeddedRunController.svelte` all trace back to this hop (progress.txt 2026-08-06).

TAILNET-0/1/2 designed the fix on 2026-08-17: put each robot on the tailnet and let the operator's browser talk to it directly. Two things kept that plan from starting:
- **Onboarding was a hand procedure.** TAILNET-1 is a list of commands to type on each robot, starting with B07.
- **The first SSH is hard to reach.** The only documented SSH key is on the lab Mac. This workstation (`alejandros-pc`) is on `172.16.202.x` and **cannot reach the robot LAN `172.16.28.x`**: `curl http://172.16.28.71:31950/health` timed out on 2026-09-25. The August bridge redeploy had to go through each robot's Jupyter server on `:48888` because the operator had no SSH key (progress.txt:9135).

This PRD makes onboarding one script plus one BIMS field, starts with **B14**, and makes the tailnet the main line to BIMS. After this, SSH to any robot works from both this PC and the lab Mac with no key file.

## 2. Goals

1. **B14 on the tailnet** as `ot2-b14`, with its robot API served over HTTPS at `https://ot2-b14.tailf65a70.ts.net`. It is reachable from both `alejandros-pc` and the lab Mac (`imac`), and from nothing else.
2. **SSH to any onboarded robot from either workstation** using Tailscale SSH (`ssh root@ot2-b14`). No `ot2_ssh_key` file and no presence on the robot LAN are needed after the one-time bootstrap.
3. **Adding a robot takes three steps:**
   - bootstrap SSH once;
   - run `scripts/ot2-tailnet-provision.sh <slot>`;
   - paste the printed URL into the robot's BIMS edit page.

   B07 and R04 must onboard with the unchanged script (S7).
4. **Tailnet as the main line:** when the browser can reach `directUrl`, the interactive actions go direct (target: UI acknowledges a pause in ≤ 500 ms).
5. **No regressions:**
   - The queue stays the automatic fallback for machines off the tailnet, and stays the path for Start Run.
   - The `ot2-bridge` daemon (heartbeats, sweeps, deck-scan, calibrator watch) is untouched.

## 3. Non-Goals

- Removing `Ot2BridgeCommand` or the on-robot `ot2-bridge.py` daemon.
- Letting **Vercel servers** call the robot directly. Serverless functions can't join the tailnet, and Funnel on a robot is forbidden (TAILNET-0 decision 5).
- Making Start Run direct. It stays on the queue because it is durable and audited.
- A lab gateway box (`LAB-GATEWAY-1-DEFERRED.md`).
- Any change to the frozen `src/lib/stores/robot-health.ts`.

## 4. Current State (origin/master)

### 4.1 Transport is chosen server-side, per deployment
`src/lib/server/opentrons/proxy.ts:23-27`:
```ts
function resolveTransport(): Ot2Transport {
	const mode = (process.env.OT2_TRANSPORT ?? 'auto').toLowerCase();
	if (mode === 'direct' || mode === 'bridge') return mode;
	return process.env.VERCEL ? 'bridge' : 'direct';
}
```
- On Vercel this always resolves to `bridge`.
- `bridgeFetch` (`proxy.ts:44-90`) enqueues a command, then polls Mongo every `BRIDGE_POLL_MS = 100` up to `BRIDGE_TIMEOUT_MS = 30_000` (`proxy.ts:37-38`).
- The bridge deviceId is derived from the slot code in the robot's name (`proxy.ts:30-35`, `/\b([A-Z]\d{2})\b/` → `ot2-b14-bridge`).

### 4.2 The daemon is outbound-only and already runs under systemd
- `scripts/ot2-bridge.py:5-6` reads: "Outbound-only: the robot polls BIMS, BIMS never dials in."
- It runs three threads (`py:2063-2067`):
  - command long-poll: `POLL_WAIT_MS` defaults to 18000 (`py:104`);
  - legacy trigger poll;
  - 10 s heartbeat.
- It is installed as `scripts/ot2-bridge.service` (`Restart=always`, `After=network-online.target`), using the remount-rw pattern in `scripts/OT2-BRIDGE-DEPLOYMENT.md` §5:
  ```
  mount -o remount,rw /
  cp /data/ot2-bridge/ot2-bridge.service /etc/systemd/system/
  systemctl daemon-reload && systemctl enable --now ot2-bridge
  mount -o remount,ro /
  ```
- **Correction to TAILNET-1 step 6:** the bridge is *not* "launched by hand today". The Tailscale unit below copies this existing pattern.

### 4.3 B14 facts (re-read from source 2026-09-25)
| Field | Value | Source |
|---|---|---|
| mDNS host | `muddy-water.local` | `scripts/seed-opentrons-robots.ts:14`, `scripts/deploy-wax-tipcal-guards.cjs:38` |
| LAN IP | `172.16.28.71` | progress.txt:7203, 9132 |
| Serial | `OT2CEP20200309B14` | `scripts/seed-opentrons-robots.ts:14` |
| `OpentronsRobot._id` | `8LufEAi5sYJ5JRk_fTfT7` | `scripts/deploy-wax-tipcal-guards.cjs:38`. **Re-verify in Mongo before any write.** |
| BIMS name | `Robot 1 B14` | `scripts/rename-opentrons-robots.ts` |
| Bridge | `ot2-b14-bridge`; calibrator-watch daemon at md5 `2320ec3f…` since 2026-08-21 | progress.txt:10087-10100 |

The other robots are B07 (`hidden-leaf.local`, `172.16.28.101`) and R04 (`ot2cep20210817r04.local`, `172.16.28.144`).

### 4.4 Tailnet today (`tailscale status`, 2026-09-25)
- Tailnet: `tailf65a70.ts.net`.
- `alejandros-pc` 100.104.29.116: online. It has **Funnel on**, and it is user-owned, not tagged.
- `imac` (the lab Mac): **offline, last seen 79 d ago.**
- `alejandrospi-cv-1` online; `alejandrospi2`, `arm-pi` offline.
- No robot is on the tailnet.

### 4.5 Call sites that bypass the transport switch
These dial `http://${robot.ip}` from the server, so they already fail on Vercel. TAILNET-2 missed them:

| File | What |
|---|---|
| `src/lib/server/opentrons/client.ts:30` | `robotBaseUrl()` → `http://${robot.ip}:${port}`; the whole `api/opentrons-clone/…` stack |
| `src/lib/server/opentrons/maintenance-clone.ts` (`rawClient`) | `createClient({ baseUrl: robotBaseUrl(robot) })` |
| `src/routes/api/opentrons-lab/robots/[id]/protocols/+server.ts:36` | `GET /protocols` |
| `src/routes/api/opentrons-lab/protocols/[protocolId]/deploy/+server.ts:31` | protocol deploy |
| `src/routes/opentrons/devices/[robotId]/+page.server.ts:24,45,58` | `/health`, `/pipettes`, `/runs` on the device page |

### 4.6 Other gaps found
- **Health reads the wrong collection.** `api/opentrons-lab/robots/health/+server.ts:21-26` reads **`Equipment`** robots (`equipmentType:'robot'`), not `OpentronsRobot`, so a per-robot field on `OpentronsRobot` is invisible there.
- **`bridgeDeviceId` isn't editable in the UI.** TAILNET-2 says "add `directUrl` next to `bridgeDeviceId`" on the edit page, but that field isn't on the page.
- **The dedicated `OT2_BRIDGE_KEY` fleet key is unused.** It is defined (`src/lib/server/fleet-keys.ts:45-50`) but no ot2 route calls `verifyFleetKey`; the bridge uses the shared `AGENT_API_KEY`. Out of scope here; noted for PERM work.

## 5. Reference / Prior art

- **CV capture Pis:** `services/bims-capture-agent/provision-station.sh`.
  - :130-137 reads the FQDN from `tailscale status --json` (`Self.DNSName`).
  - :229-235 runs an idempotent `tailscale serve --bg --https=443 http://localhost:8765`.
  - The browser then dials the station directly (`src/routes/capture/+page.svelte:591,608`).
  - This is the exact shape we're copying.
- **Robot arm:** `ROBOT_ARM_BASE_URL=https://arm-pi.tailf65a70.ts.net` via Funnel (`.env.example:90-99`). This is the counter-example: a server calling the device through a public Funnel. It is not allowed for robots.
- `OT2-TAILNET-2-DIRECT-CONTROL.md`: the full BIMS-side design (direct-client, `record` route, transport pill). Kept as-is, except for the §7.4 additions.

## 6. Data Model & Source

`OpentronsRobot` (`src/lib/server/db/models/opentrons-robot.ts`, collection `opentrons_robots`) gains:
```ts
directUrl: { type: String }        // https://ot2-b14.tailf65a70.ts.net (https, no port, no path, no trailing slash)
tailnetHostname: { type: String }  // ot2-b14; the provision script prints it, used for display/SSH hints
```
- Both fields are unset for robots not yet onboarded. Unset means behaviour identical to today.
- `Equipment` robots are joined to `OpentronsRobot` by `name` for the health path (see §4.6).
- The client gets `directUrl` wherever the load functions already return the robot.

## 7. Design / Architecture

### 7.1 Access model: ACLs

Robots get tag **`tag:ot2`**. Workstations are allowed in by **user group**, not by tag:
- Tagging `alejandros-pc` would turn it from a user device into a tagged device. That changes its ownership and could disturb its existing Funnel.
- A user group covers "this PC and the lab Mac" in one line.

Proposed policy additions, committed as documentation at `docs/tailnet/acl.json`. **Append to the live policy; never replace it**, or the CV stations lose access.
```jsonc
{
  "groups":    { "group:ot2-operators": ["avacoder3900@github"] },   // add Jacob etc. — Q1
  "tagOwners": { "tag:ot2": ["autogroup:admin"] },
  "acls": [
    { "action": "accept", "src": ["group:ot2-operators"], "dst": ["tag:ot2:443", "tag:ot2:22"] }
  ],
  "ssh": [
    { "action": "accept", "src": ["group:ot2-operators"], "dst": ["tag:ot2"], "users": ["root"] }
  ]
}
```
- Robots are *destinations only*. There is no rule letting `tag:ot2` reach anything, so a compromised robot can't reach the tailnet. Outbound internet traffic (the bridge → Vercel) is unaffected.
- **No Funnel on any robot, ever.**
- **Tailscale SSH** (`--ssh`) is what satisfies "both computers can SSH in". The tailnet identity is the credential, so the `ot2_ssh_key` file is only needed for the one-time bootstrap.

### 7.2 One-time bootstrap (per robot, only until it is on the tailnet)
You need *some* shell on the robot once. Any one of these works; they are listed in order of preference:

| Path | From | How |
|---|---|---|
| **A. Lab Mac + key** | lab Mac (on the robot LAN) | `ssh -i ot2_ssh_key root@172.16.28.71` (key at `docs/brevitest-opentrons-files-4-21/ot2_ssh_key`; it is not in the `C:\Users\aleja\BIMS-V2` clone) |
| **B. Register this PC's key** | any machine on `172.16.28.x` | `curl -X POST http://172.16.28.71:31950/server/ssh_keys -H 'Opentrons-Version: *' -H 'Content-Type: application/json' -d '{"key":"<contents of id_ed25519.pub>"}'`. The robot accepts this only from its local network. |
| **C. Jupyter terminal** | any machine on `172.16.28.x` | `http://172.16.28.71:48888`, Terminal. This is how the August bridge redeploy was done (progress.txt:9135). |

The lab Mac is the tailnet node `imac`, but it has been offline for 79 days. It can serve as the jump host only after it rejoins; until then, use it in person or through the Opentrons App machine.

### 7.3 Repeatable provisioning: `scripts/ot2-tailnet-provision.sh`
Run it from any workstation that already has a shell path to the robot (bootstrap A/B, or Tailscale SSH on a re-run). It is **idempotent**, so re-running it after an Opentrons OS update is the recovery procedure.

```
scripts/ot2-tailnet-provision.sh <slot> [--host <ip|name>] [--authkey-file <path>]
#   slot  = b14 | b07 | r04 | …   → hostname ot2-<slot>
```
What it does, in order. It aborts on the first failure and prints a ✓ or ✗ for each step:
1. **Preflight.** SSH works; `uname -m` detects the arch (the OT-2 is a Pi 3B+ with 32-bit userland, so expect the `arm` build); `/data` has ≥ 60 MB free; `[ -c /dev/net/tun ]` decides kernel TUN vs `--tun=userspace-networking`.
2. **Install.** Download the pinned static tarball on the workstation (`TAILSCALE_VERSION` at the top of the script), then `scp -O` it (the OT-2 has no sftp-server) to `/data/tailscale/` and unpack it there. The robot needs no outbound access to pkgs.tailscale.com.
3. **Persist.** `scp -O scripts/ot2-tailscale.service` (new) into `/data/tailscale/`, then use the same remount-rw / `systemctl enable --now` / remount-ro sequence as the bridge (§4.2). The unit runs:
   ```
   /data/tailscale/tailscaled --state=/data/tailscale/tailscaled.state \
     --socket=/data/tailscale/tailscaled.sock [--tun=userspace-networking]
   ```
   `ExecStartPost` applies the `serve` config (step 5).
4. **Join.** Run `tailscale up --hostname=ot2-<slot> --advertise-tags=tag:ot2 --ssh --authkey=file:<path>`.
   - The key is a **tagged pre-auth key**, so there is no admin-console click and a wiped robot rejoins as the same tag.
   - The key file is copied to `/data/tailscale/authkey` with mode 600 and deleted after a successful join.
5. **Serve.** Run `tailscale serve --bg --https=443 http://localhost:31950`. This is idempotent (same pattern as `provision-station.sh:229-235`).
6. **Verify.** Read `Self.DNSName` from `tailscale status --json`, then from the workstation:
   - `curl -s https://<fqdn>/health -H 'Opentrons-Version: *'` must return JSON with `name`;
   - the CORS preflight from TAILNET-1 step 5, with the BIMS origin, must show `Access-Control-Allow-Origin`;
   - `systemctl is-active ot2-bridge` must still be `active`.
7. **Print** the `directUrl` and the `tailnetHostname` to paste into BIMS.

`scripts/OT2-BRIDGE-DEPLOYMENT.md` gets a "Tailscale" section with the three-step "Add a robot" flow and an OS-update recovery line: *re-run the script*.

**CORS contingency.** If step 6 shows robot-server does not answer the preflight permissively, `tailscale serve` cannot add headers. In that case the script installs a small header-injecting reverse proxy (Python stdlib, on `127.0.0.1:31951`) and points `serve` at it instead. Whichever way it goes, the result is recorded in this doc (see Q3).

### 7.4 BIMS side: TAILNET-2 plus these additions
TAILNET-2's design is kept in full:
- `direct-client.ts`, which probes `{directUrl}/health` with a 1500 ms timeout and caches the result for 60 s;
- falling back to the queue for each call;
- the `record` route for audit of direct actions;
- the transport pill in `EmbeddedRunController.svelte`.

Additions:
1. **`directUrl` and `tailnetHostname` on the edit page**, validated as `^https://[a-z0-9-]+\.tailf65a70\.ts\.net$`. Each change writes an AuditLog entry (`tableName:'opentrons_robots'`, `oldData/newData`). `bridgeDeviceId` is added to the same form as a read-only display.
2. **Device page and protocol list** (§4.5): today these fetch the robot from the server. When the robot has a `directUrl`, move those fetches client-side through `direct-client`; otherwise keep today's queue path via `robotGet`. This fixes the existing Vercel breakage on the way.
3. **Health:** `getHealth` goes direct when possible. The `Equipment`→`OpentronsRobot` name join (§4.6) supplies the `directUrl`.
4. **The `opentrons-clone` stack is out of scope.** It can adopt `direct-client` later.

The rule is unchanged from TAILNET-2: **the robot is the source of truth for live state; BIMS records intent and terminal state.**

## 8. UX Spec

- **Robots list** (`/opentrons/devices`): a small `tailnet` / `queue only` badge per robot, using tron tokens (`var(--color-tron-*)`). Robots with a `directUrl` show `ot2-b14` under the IP.
- **Edit page:** a new "Tailnet" section with `Direct URL`, `Tailnet hostname` and read-only `Bridge device`. The helper text reads: "Paste the URL printed by `scripts/ot2-tailnet-provision.sh`. Leave blank to use the Vercel queue only."
- **Run controller and jog pages:** the 10 px transport pill from TAILNET-2. Green `direct`; grey `queue` with the tooltip "direct link unavailable — using queue".

## 9. Stories

| ID | Story | AC |
|---|---|---|
| **S1** | Bootstrap B14 and join the tailnet | `tailscale status` on **`alejandros-pc`** and on **`imac`** both list `ot2-b14` online with tag `tag:ot2`. `ssh root@ot2-b14 hostname` works from both, with no key file. |
| **S2** | HTTPS front plus CORS check on B14 | From both workstations, `curl -s https://ot2-b14.tailf65a70.ts.net/health -H 'Opentrons-Version: *'` returns JSON with `name`. The CORS outcome is recorded in §7.3. |
| **S3** | Reboot persistence on B14 | After `reboot`, with no hands: tailscaled, serve and ot2-bridge all active; the BIMS heartbeat for `ot2-b14-bridge` resumes within 60 s. |
| **S4** | ACL | The policy diff is committed at `docs/tailnet/acl.json`. A tailnet node outside `group:ot2-operators` (e.g. `alejandrospi-cv-1`) cannot open `:443` or `:22` on `ot2-b14`. The CV stations' existing access still works. |
| **S5** | Provision script plus systemd unit | `scripts/ot2-tailnet-provision.sh b14` run a **second** time is a no-op with every step green. |
| **S6** | `directUrl` field and edit UI plus audit | Setting or clearing it on B14 writes an AuditLog entry. When unset, the network trace is byte-identical to today (queue only). |
| **S7** | direct-client wired into run control, jog, health, device page and protocol list | On a tailnet workstation, B14 pause is reflected in ≤ 500 ms with the pill showing `direct`. On a non-tailnet device the same buttons work with the pill showing `queue`. Unplugging B14's Ethernet mid-run flips the next action to the queue with no stuck UI. `OpentronsRunRecord` and AuditLog for a direct action match the queue path, plus `transport:'direct'`. |
| **S8** | Onboard B07, then R04, with the unchanged script | Both pass S1–S3's ACs. Only BIMS data changes (their `directUrl`). |
| **S9** | Docs and logs | The "Add a robot" section in `OT2-BRIDGE-DEPLOYMENT.md`; the post-update checklist in `LAB-MAC-RUNBOOK-OT2-BRIDGE.md`; a progress.txt entry for each robot onboarded (a robot-side deployment entry, per CLAUDE.md format). |

S1–S5 are lab and script work, and together they deliver "SSH to B14 from both machines" on their own. S6–S7 are the BIMS build (about a day, per the TAILNET-2 estimate, plus about half a day for §7.4).

## 10. Open Questions / Risks

- **Q1 — Who is in `group:ot2-operators`?** Just `avacoder3900`, or also Jacob and the lab accounts? And is the lab Mac signed in as one of them? *(User/Jacob)*
- **Q2 — Pre-auth key.** Who creates it, is it reusable or one-off, and what expiry? Recommendation: a reusable, tagged `tag:ot2` key with a 90-day expiry, stored outside the repo.
- **Q3 — CORS.** It is unknown until S2 runs. It decides between plain `serve` and the header proxy.
- **Q4 — TUN on the Opentrons kernel.** It is unknown until preflight. Userspace mode covers `serve` and SSH either way.
- **Q5 — OS updates.** Do Opentrons OS updates wipe `/etc/systemd/system`? `/data` survives. Mitigation: re-running the script is the recovery, and it is on the post-update checklist.
- **Q6 — Lab Mac availability.** `imac` has been offline for 79 days. For "both computers can access it", the lab Mac has to be brought back online in Tailscale and should stay signed in. Should it be the always-on jump host? *(User)*
- **Risk — ACL edits.** A careless edit can cut the CV stations off. Mitigation: append only, run a preview via the admin console's "Preview rules", and check S4's CV station access.
- **Risk — two writers.** The browser acts on the robot and then records the action in BIMS. This is bounded exactly as in TAILNET-2 §3.
- **Risk — pxpipe identifier drift.** The robot `_id`, the FQDN and the pre-auth key must be re-read at the moment of use, never recalled from earlier context.

## 11. Test / Validation Plan

1. **Lab, B14 (S1–S5):**
   - Run the script.
   - Run the S1/S2 curls and SSH from both workstations.
   - Reboot test.
   - ACL negative test from `alejandrospi-cv-1`.
   - Re-run the script to confirm it is idempotent.
2. **BIMS (S6–S7):** `npm run check` at the current baseline, plus unit tests for the `resolveTransport` fallback:
   - healthy → direct;
   - timeout → queue;
   - a mid-call 5xx → queue for 60 s.
   Then push to a Vercel preview (never a local deploy; `npm run build` OOMs on this machine) and log it in progress.txt.
3. **Real-run parity:** a B14 reagent fill with pause, resume and cancel from `alejandros-pc` (expect `direct`) and from a phone off the tailnet (expect `queue`). Diff the `OpentronsRunRecord` and AuditLog rows for the two paths.
4. **Daemon untouched:** after onboarding, sweep and deck-scan run from the wax/reagent page exactly as before.

## 12. Out of Scope

Vercel→robot server calls over the tailnet; Funnel on robots; the `opentrons-clone` stack; removing the queue or daemon; `OT2_BRIDGE_KEY` enforcement; the lab gateway.

---

## 13. B14 onboarding log (2026-09-25): what hardware actually said

S1–S2 were done by hand from `alejandros-pc`. These findings **override** the assumptions above; the provision script must encode them.

- **The LAN IP moved.** B14 is now `172.16.202.117` (DHCP), on the same Wi-Fi subnet as `alejandros-pc`. The `172.16.28.71` in §4.3 and the older docs is stale. It was found via mDNS: `ping -4 muddy-water.local`. Once on the tailnet, the IP no longer matters.
- **SSH bootstrap = path B, and it works from this PC.** B14 already trusted three keys (Leo's Mac Pro and two `brevitest@brevitest1` keys from the lab Mac, so the lab Mac can SSH in by IP today).
  - `POST /server/ssh_keys` **rejects ed25519** (`"Key starts with invalid algorithm ssh-ed25519"`). Use **RSA**: the key is `~/.ssh/ot2_rsa` (4096, no passphrase).
  - The endpoint only accepts requests via the **IPv6 link-local** address: `http://[fe80::…%<if>]:31950`.
- **Arch `armv7l`** → the `tailscale_<ver>_arm.tgz` build (1.102.4 installed), in `/data/tailscale/`. About 10 GB is free on `/data`.
- **Kernel TUN exists but is unusable.** `/dev/net/tun` is present, but tailscaled reports `netlink receive: invalid argument` ("create table"): the kernel lacks policy routing. **Userspace networking is required**; `scripts/ot2-tailscale.service` sets `--tun=userspace-networking`. SSH and `serve` both work in this mode.
- **Persistence:** `ot2-tailscale.service` is installed with the bridge's remount-rw pattern and is `enabled`. The `serve --bg` config lives in `tailscaled.state`. **The reboot test (S3) has not been run yet.**
- **The login account matters.** The first two approvals went to a personal Gmail tailnet (`tail8a9291`) because the browser was signed into Tailscale with Gmail. Use a private window and sign in with **GitHub `avacoder3900`**, or better, a pre-auth key (Q2). The stale `ot2-b14` node in the Gmail tailnet should be deleted there.
- **Result:**
  - `ot2-b14` is `100.122.230.39` on `tailf65a70`.
  - `tailscale ping` from `alejandros-pc` gives 22 ms, over a direct (non-DERP) path.
  - `https://ot2-b14.tailf65a70.ts.net/health` returns 200. The first TLS request took about 8 s while the certificate was issued; after that, **~0.44 s including a fresh TLS handshake**.
- **CORS (Q3) passes with plain `serve`.** The preflight from the BIMS origin returns `Access-Control-Allow-Origin: https://bioscale-operations-system-mongodb.vercel.app` with `Allow-Headers: opentrons-version,content-type`, so the header-proxy contingency in §7.3 is not needed.
- **Tailscale SSH works** (`ssh root@ot2-b14`), but the tailnet's default SSH policy uses **`check`** mode (a browser re-auth link roughly every 12 h). Changing it to `accept` for `group:ot2-operators` is part of S4. Until then, keyed SSH to `root@172.16.202.117` with `~/.ssh/ot2_rsa` works on the LAN.
- **The bridge is untouched:** `ot2-bridge` is still `active`.
- **Still open:**
  - S3: reboot test.
  - S4: ACL / `tag:ot2` / SSH `accept`. Until S4, B14 is reachable from **any** device on the tailnet, and robot-server has no auth.
  - The lab Mac (`imac`) rejoining the tailnet.

## Appendix A — File change map

| Change | Path |
|---|---|
| Add | `scripts/ot2-tailnet-provision.sh` |
| Add | `scripts/ot2-tailscale.service` |
| Add | `docs/tailnet/acl.json` (documentation copy of the policy additions) |
| Add | `src/lib/opentrons/direct-client.ts` (+ test) — per TAILNET-2 |
| Add | `src/routes/api/opentrons-lab/robots/[id]/runs/[rid]/record/+server.ts` — per TAILNET-2 |
| Modify | `src/lib/server/db/models/opentrons-robot.ts` (`directUrl`, `tailnetHostname`) |
| Modify | `src/routes/opentrons/devices/[robotId]/edit/+page.server.ts` + `+page.svelte` |
| Modify | `src/routes/opentrons/devices/[robotId]/+page.server.ts` / `+page.svelte` (direct fetches) |
| Modify | `src/routes/opentrons/devices/+page.svelte` (tailnet badge) |
| Modify | `EmbeddedRunController.svelte`, jog/teach pages, health widget — per TAILNET-2 |
| Modify | `scripts/OT2-BRIDGE-DEPLOYMENT.md`, `docs/LAB-MAC-RUNBOOK-OT2-BRIDGE.md` |
| Modify | `docs/prds/OT2-TAILNET-0-PLAN.md`, `OT2-TAILNET-1-PI-PROVISIONING.md` (pointer to this PRD) |

## Appendix B — Reference pointers

- PRDs:
  - `OT2-TAILNET-0-PLAN.md`, `OT2-TAILNET-1-PI-PROVISIONING.md`, `OT2-TAILNET-2-DIRECT-CONTROL.md`, `LAB-GATEWAY-1-DEFERRED.md`
  - `OT2-BRIDGE-1-COMMAND-BRIDGE.md`, `OT2-RUN-CONTROL-RELIABILITY.md`
- Code:
  - `src/lib/server/opentrons/proxy.ts`, `health.ts`, `client.ts`
  - `scripts/ot2-bridge.py`, `scripts/ot2-bridge.service`
- CV provisioning pattern: `services/bims-capture-agent/provision-station.sh`, `RUNBOOK.md` Phases 2 and 5.
- Robot identifiers: `scripts/seed-opentrons-robots.ts`, `scripts/deploy-wax-tipcal-guards.cjs`.
