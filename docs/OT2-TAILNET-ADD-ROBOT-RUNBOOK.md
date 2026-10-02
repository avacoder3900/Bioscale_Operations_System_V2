# OT-2 → Tailscale: add a robot (runbook for Claude)

**Purpose:** put one more OT-2 on the BIMS tailnet line, exactly like B14 (done 2026-09-30).
**Who runs it:** Claude, from `alejandros-pc`, in the worktree `C:\Users\aleja\BIMS-V2\.worktrees\ot2-tailnet-direct` (branch `feat/ot2-tailnet-direct`). The user only has to be present for the gate checks and the browser test.
**Time:** about 10 min per robot, plus about 3 min for one shared Vercel rebuild.

> **Exact-identifier rule:** re-read every ID, URL and hash from its source at the moment you use it (commands below do that). Never paste one recalled from earlier context.

---

## 0. Fleet facts (as of 2026-10-02, re-check before use)

| Slot | BIMS name | LAN IP (SSH) | Tailnet URL | Right pipette | Daemon | State |
|---|---|---|---|---|---|---|
| b14 | Robot 1 B14 | 172.16.202.117 | https://ot2-b14.tailf65a70.ts.net | p1000 (can't run wax) | **1.2, /bridge live** | ✅ done |
| b07 | Robot 3 B07 | 172.16.202.123 | https://ot2-b07.tailf65a70.ts.net | p20 ✓ | 1.0, no /bridge | ⏳ todo |
| r04 | Robot 2 R04 | 172.16.202.124 | https://ot2-r04.tailf65a70.ts.net | p20 ✓ | 1.0, no /bridge | ⏳ todo |

The following are already done for all three robots (TAILNET-3, 2026-09-29): Tailscale installed, joined as `ot2-<slot>`, `serve /` → `:31950`, and an SSH key at `~/.ssh/ot2_rsa`.

Shared values:
- SSH: `ssh -i ~/.ssh/ot2_rsa root@<LAN IP>`. Tailscale SSH asks for a browser re-auth, so use the LAN IP.
- Secret file: `~/.bims/ot2-bridge-secret`. The same secret is used for every robot and is already in Vercel Preview. **Never print it.**
- Preview (branch alias): `https://bioscale-operations-system-mongodb-git-feat-ot-2ae11c-brevitest.vercel.app`

---

## 1. GATE — robot must be idle (do not skip)

A robot program restart doesn't stop a protocol run, but it does drop an in-flight auto-resume or scan. **Never onboard a robot that is mid-fill.**

```bash
S=b07   # or r04
curl -s -m 8 -H 'Opentrons-Version: *' https://ot2-$S.tailf65a70.ts.net/runs | python -c "
import sys,json; d=json.load(sys.stdin); cur=(d.get('links',{}).get('current') or {}).get('href','').rsplit('/',1)[-1]
st=[r['status'] for r in d['data'] if r['id']==cur]; print('current:', cur or None, st)"
```
- Go ahead **only** if `current: None`, or if the status is `succeeded`, `stopped` or `failed`.
- If it shows `running`, `paused`, `finishing` or `awaiting-recovery`: **stop and tell the user.** Wait for the fill to end. Don't do it for them.

## 2. Robot program → 1.2 (backup, compile, swap)

```bash
cd /c/Users/aleja/BIMS-V2/.worktrees/ot2-tailnet-direct
IP=172.16.202.123   # b07 | r04 → 172.16.202.124
K=~/.ssh/ot2_rsa
ssh -i $K -o BatchMode=yes root@$IP "cat > /data/ot2-bridge/ot2-bridge.py.new" < scripts/ot2-bridge.py
ssh -i $K -o BatchMode=yes root@$IP 'cd /data/ot2-bridge && python3 -m py_compile ot2-bridge.py.new && grep -m1 "^VERSION" ot2-bridge.py.new && cp -p ot2-bridge.py ot2-bridge.py.v1.0.bak && mv ot2-bridge.py.new ot2-bridge.py && md5sum ot2-bridge.py'
md5sum scripts/ot2-bridge.py     # must match the line above
```
Expect `VERSION = "ot2-bridge/1.2"` and matching md5 sums. The program hasn't restarted yet; step 4 does that.

## 3. Point its reports at the branch preview

The `/bridge` sweep results need the `/api/agent/ot2/jobs` routes, which exist **only on this branch**.
```bash
NEW=https://bioscale-operations-system-mongodb-git-feat-ot-2ae11c-brevitest.vercel.app
ssh -i $K -o BatchMode=yes root@$IP "cd /data/ot2-bridge && cp -p .env .env.bak-\$(date +%Y%m%d) && sed -i 's#^BIMS_BASE_URL=.*#BIMS_BASE_URL=$NEW#' .env && grep -c '^BIMS_BASE_URL=' .env && sed -n 's/^BIMS_BASE_URL=//p' .env"
```
Expect `1` and the preview URL. The robot has no `stat`, so use `ls -l .env` to check the mode is `-rw-------`.

## 4. Provision `/bridge` (secret + serve path + restart)

Re-read the robot's BIMS `_id` first; don't copy it from this doc:
```bash
cat > $TEMP/rid.mjs <<'EOF'
import { readFileSync } from 'node:fs'; import { MongoClient } from 'mongodb';
const uri = readFileSync('C:/Users/aleja/.env','utf8').split(/\r?\n/).find(l=>l.startsWith('MONGODB_URI=')).slice(12).replace(/^["']|["']$/g,'');
const c = new MongoClient(uri); await c.connect();
for (const r of await c.db().collection('opentrons_robots').find({}, {projection:{name:1,connection:1}}).toArray()) console.log(r._id, '|', r.name, '|', r.connection?.mode ?? 'queue', r.connection?.directUrl ?? '');
await c.close();
EOF
node $TEMP/rid.mjs; rm -f $TEMP/rid.mjs
```
Then (`S` = slot, `RID` = that robot's `_id` from the output above):
```bash
bash scripts/ot2-tailnet-provision.sh $S --host $IP --key ~/.ssh/ot2_rsa \
  --secret-file ~/.bims/ot2-bridge-secret --robot-id $RID
```
Expect every line ✓, ending with `/bridge/health → 401 without a token`.

If the auto-mode classifier blocks this (it did once, as "Remote Shell Writes"), tell the user. They either say "you run it" or run it themselves with `!`.

## 5. Verify the robot

```bash
TOKEN=$(ssh -i $K -o BatchMode=yes root@$IP 'cd /data/ot2-bridge && set -a && . ./.env && set +a && python3 ot2-bridge.py --mint-token scan')
curl -s -m 10 -o /dev/null -w "no token: %{http_code}\n" https://ot2-$S.tailf65a70.ts.net/bridge/health          # 401
curl -s -m 10 -H "Authorization: Bearer $TOKEN" https://ot2-$S.tailf65a70.ts.net/bridge/health | python -c "import sys,json; d=json.load(sys.stdin); print(d['version'], 'jobServer', d['jobServer'], 'serialOpen', d['serialOpen'], 'engineOk', d['heartbeat']['engine']['engineOk'])"
ssh -i $K -o BatchMode=yes root@$IP 'systemctl is-active ot2-bridge; journalctl -u ot2-bridge -n 8 --no-pager | grep -iE "starting|WARN|ERROR" | cut -c1-160'
```
Pass when all of these hold:
- you get `401`;
- the token call returns `ot2-bridge/1.2 jobServer True serialOpen True engineOk True`;
- the service is `active`;
- there are no `401`/`404` warnings in the journal.

`serialOpen False` means the scanner is unplugged. Tell the user; it isn't a blocker for run control.

Heartbeat reaches BIMS (shared Mongo):
```bash
cat > $TEMP/hb.mjs <<'EOF'
import { readFileSync } from 'node:fs'; import { MongoClient } from 'mongodb';
const uri = readFileSync('C:/Users/aleja/.env','utf8').split(/\r?\n/).find(l=>l.startsWith('MONGODB_URI=')).slice(12).replace(/^["']|["']$/g,'');
const c = new MongoClient(uri); await c.connect();
const id = `hb:ot2-${process.argv[2]}-bridge`;
const d = await c.db().collection('scanner_events').findOne({ _id: id });
console.log(id, d ? `${Math.round((Date.now()-d.receivedAt)/1000)}s ago ${d.metadata?.version ?? ''}` : 'NONE'); await c.close();
EOF
node $TEMP/hb.mjs $S; rm -f $TEMP/hb.mjs
```
Pass if it was under 30 s ago and shows `ot2-bridge/1.2`.

## 6. BIMS robot record → tailnet

This step is **for the user, in the browser** (it writes an AuditLog row, which is why it goes through the UI). On the preview, open `/opentrons/devices/<RID>/edit` and set the **Tailnet** section:
- Mode: `Tailnet (direct)`
- Tailnet hostname: `ot2-<slot>`
- Direct URL: `https://ot2-<slot>.tailf65a70.ts.net` (no trailing slash)

Re-run the step-4 `rid.mjs` to confirm it saved (`tailnet https://ot2-<slot>…`).

This is safe for production: prod BIMS has no `OT2_TAILNET_ROBOT_IDS`, so it keeps using the queue for this robot.

## 7. Enable it on the preview deployment (once, after all robots)

Do this once for the whole batch, not per robot. Matching is by **robot name** ("Robot 3 B07" contains `b07`), not by hostname.
```bash
cd /c/Users/aleja/BIMS-V2
npx vercel env rm OT2_TAILNET_ROBOT_IDS preview --yes
printf 'b14,b07,r04' | npx vercel env add OT2_TAILNET_ROBOT_IDS preview
npx vercel env ls preview | grep OT2        # both OT2_* rows, Preview
cd .worktrees/ot2-tailnet-direct
git commit --allow-empty -m "chore: rebuild preview (OT2_TAILNET_ROBOT_IDS += b07,r04)" && git push origin feat/ot2-tailnet-direct
```
Env changes only apply to a **new build**; wait for the brevitest Vercel status to show `success`.

## 8. Browser test (with the user, ~5 min per robot)

On the preview, from a tailnet PC in Chrome, open the wax or reagent page and pick the robot:
1. The pill reads **`direct`**. If Chrome asks for local network access, Allow.
2. Start a fill. It auto-resumes past the start pause by itself.
3. Pause from a **second tab**. It stays paused (it must not auto-resume).
4. While it's paused, try a deck scan. It must **refuse** with "refusing to auto-clear it", and the fill must stay paused.
5. Resume, then finish or cancel. Check the AuditLog rows say `line: 'tailnet'`.
6. Optional: turn off Tailscale on the PC. The pill goes to `queue`; turn it back on and the pill returns to `direct` within about 30 s.

## 9. Log it (mandatory)

Append a progress.txt entry for each robot, plus a `Deployment: robot — <slot> …` line in the CLAUDE.md format. Include the md5, the backups and the rollback below. Commit and push, then report the commit and branch.

## Rollback (per robot, ~1 min)

```bash
ssh -i ~/.ssh/ot2_rsa root@<IP> 'cd /data/ot2-bridge && cp ot2-bridge.py.v1.0.bak ot2-bridge.py && cp .env.bak-<date> .env && export PATH=$PATH:/data/tailscale && tailscale --socket=/data/tailscale/tailscaled.sock serve --https=443 --set-path=/bridge off; systemctl restart ot2-bridge'
```
In BIMS, set the robot's Mode back to `Queue`. The queue line works unchanged with daemon 1.0.

## Before merging to master (not today unless asked)

- Point every robot's `BIMS_BASE_URL` back to prod (`https://bioscale-operations-system-mongodb.vercel.app`) **after** the jobs routes are on master.
- Add `OT2_BRIDGE_TOKEN_SECRET` (the same file) and `OT2_TAILNET_ROBOT_IDS` to **Production**. That's a deliberate switch-over, so decide it with the user.
- Run the reboot test (TAILNET-3 S3) on at least one robot.
