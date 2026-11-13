/**
 * Deploy the repo's protocols/Sample_Diluent_Fill_v2.py to an OT-2 and record it
 * in BIMS the way the Import button would (DILUENT-FILL-1). Modelled on
 * deploy-reagent-protocol.cjs (2026-10-12).
 *
 * Per robot: upload the .py + every BIMS labware def (Mongo `labware_definitions`,
 * the Studio-corrected geometry — the same fat bundle the non-hardened upload
 * route sends) straight to the robot's HTTP API over the lab LAN / Tailscale,
 * wait for the analysis, gate on it completing with the diluent RTPs and no
 * errors, then repoint opentrons_robots.protocols[]'s diluent-filling entry
 * (what the Robots-page diluent wizard lists) and write an audit_log row.
 * Robots with a live BIMS wax/reagent/diluent run are SKIPPED.
 *
 *   node scripts/deploy-diluent-protocol.cjs                           # verify only (uploads, no Mongo writes)
 *   DEPLOY_APPLY=1 ROBOTS=b14 node scripts/deploy-diluent-protocol.cjs # repoint B14
 *   STORE=1 also makes it the stored active diluent-filling OpentronProtocol
 *           (what the run-start freshness gate re-uploads); idempotent on hash.
 *   REQ=<username> names who asked (recorded in uploadedBy / changedBy).
 *
 * MONGODB_URI from the environment, else from <repo>/.env.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('mongoose');

const REPO = path.resolve(__dirname, '..');
const MONGODB_URI = process.env.MONGODB_URI || (() => {
  const env = fs.readFileSync(path.join(REPO, '.env'), 'utf8');
  const line = env.split('\n').find((l) => l.trim().startsWith('MONGODB_URI'));
  if (!line) throw new Error('MONGODB_URI not set and not in .env');
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
})();

const ROBOTS = {
  b07: { id: '2vIu0fzsbqzkZ7_Zjj3h2', hosts: ['100.109.115.63', '172.16.202.123'], name: 'B07' },
  r04: { id: 'CCyX8FjTRGvYOd9vISGvi', hosts: ['100.88.240.14', '172.16.202.124'], name: 'R04' },
  // B14: lab WiFi (2026-10-27 rollback), wired link-local, tailnet, old lab LAN.
  b14: { id: '8LufEAi5sYJ5JRk_fTfT7', hosts: ['192.168.1.206', '169.254.134.36', '100.122.230.39', '172.16.202.117'], name: 'B14' }
};
const PROCESS_TYPE = 'diluent-filling';
const FILE_NAME = 'Sample_Diluent_Fill_v2.py';
const PROTOCOL = path.join(REPO, 'protocols', FILE_NAME);
const H = { 'opentrons-version': '*' };
const APPLY = process.env.DEPLOY_APPLY === '1';
const STORE = process.env.STORE === '1';
const WANT = (process.env.ROBOTS || 'b14').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const REQ = process.env.REQ ? ` (req: ${process.env.REQ})` : '';
const ACTOR = `deploy-diluent-protocol${REQ}`;
const REQUIRED_RTPS = ['pipette', 'src_1_tubes', 'src_2_tubes', 'src_3_tubes', 'src_1_ml', 'src_2_ml', 'src_3_ml', 'diluent_vol', 'tubes_per_trip'];
const STORED_NAME = process.env.STORED_NAME || 'Sample Diluent Fill v2';

async function reachable(hosts) {
  for (const h of hosts) {
    try {
      const r = await fetch(`http://${h}:31950/health`, { headers: H, signal: AbortSignal.timeout(6000) });
      if (r.ok) return h;
    } catch { /* next */ }
  }
  return null;
}

async function liveRun(db, robotId) {
  const q = (col, filter) => db.collection(col).findOne(filter, { projection: { _id: 1, status: 1 } });
  const busy = ['Running', 'running', 'Setup', 'setup', 'Loading'];
  const reagent = await q('reagent_batch_records', { 'robot._id': robotId, status: { $in: busy } });
  if (reagent) return `reagent ${reagent._id} ${reagent.status}`;
  const wax = await q('wax_filling_runs', { 'robot._id': robotId, status: { $in: [...busy, 'AwaitingRemoval', 'PostRunCooling'] } });
  if (wax) return `wax ${wax._id} ${wax.status}`;
  const dil = await q('diluent_fill_runs', { robotId, status: { $in: ['Setup', 'Loading', 'Running'] } });
  if (dil) return `diluent ${dil._id} ${dil.status}`;
  return null;
}

async function deployTo(db, key, labware, pyBuf) {
  const R = ROBOTS[key];
  const live = await liveRun(db, R.id);
  if (live) { console.log(`\n[${R.name}] SKIPPED — live run on this robot (${live}). Re-run after it finishes.`); return { skipped: true }; }
  const host = await reachable(R.hosts);
  if (!host) { console.log(`\n[${R.name}] SKIPPED — unreachable on ${R.hosts.join(' / ')}`); return { skipped: true }; }

  console.log(`\n[${R.name}] uploading ${FILE_NAME} (${(pyBuf.length / 1024).toFixed(1)} KB) + ${labware.length} labware defs via ${host}`);
  const form = new FormData();
  form.append('files', new Blob([pyBuf], { type: 'text/x-python' }), FILE_NAME);
  for (const lw of labware) form.append('files', new Blob([lw.json], { type: 'application/json' }), lw.fileName);
  const up = await fetch(`http://${host}:31950/protocols`, { method: 'POST', headers: H, body: form, signal: AbortSignal.timeout(180000) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`[${R.name}] upload failed ${up.status}: ${JSON.stringify(upBody).slice(0, 300)}`);
  const pid = upBody?.data?.id;
  console.log(`  protocolId=${pid} (${up.status === 200 ? 'already on the robot — same files' : 'new'})`);

  let det = null, status = 'pending';
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const ar = await fetch(`http://${host}:31950/protocols/${pid}/analyses`, { headers: H, signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
    const list = ar?.data ?? [];
    if (!list.length) continue;
    const latest = list[list.length - 1];
    status = latest.status;
    if (status === 'completed') {
      det = await fetch(`http://${host}:31950/protocols/${pid}/analyses/${latest.id}`, { headers: H, signal: AbortSignal.timeout(30000) }).then((r) => r.json()).then((j) => j?.data ?? null).catch(() => null);
      break;
    }
    if (status === 'failed') break;
    process.stdout.write('.');
  }
  console.log(`\n  analysis status=${status} result=${det?.result ?? '?'}`);
  const errs = det?.errors ?? [];
  if (errs.length) {
    for (const e of errs) console.log('  ANALYSIS ERROR:', e.errorType ?? '', '-', (e.detail ?? JSON.stringify(e)).slice(0, 600));
    throw new Error(`[${R.name}] analysis reported errors — NOT repointing`);
  }
  if (status !== 'completed' || !det) throw new Error(`[${R.name}] analysis did not complete — NOT repointing`);
  if (det.result && det.result !== 'ok') throw new Error(`[${R.name}] analysis result ${det.result} — NOT repointing`);

  const params = det.runTimeParameters ?? [];
  const names = params.map((p) => p.variableName);
  const missing = REQUIRED_RTPS.filter((n) => !names.includes(n));
  console.log(`  RTPs (${names.length}): ${names.join(', ')}`);
  console.log(`  pipettes: ${(det.pipettes ?? []).map((p) => `${p.pipetteName}@${p.mount}`).join(', ') || 'none'}`);
  console.log(`  labware: ${(det.labware ?? []).map((l) => `${l.loadName}${l.location?.slotName ? '@' + l.location.slotName : ''}`).join(', ') || 'none'}`);
  if (missing.length) throw new Error(`[${R.name}] expected RTPs missing (${missing.join(',')}) — NOT repointing`);
  if (!APPLY) { console.log(`  VERIFY-ONLY — re-run with DEPLOY_APPLY=1 to repoint ${R.name} at ${pid}`); return { pid, verified: true }; }

  const coll = db.collection('opentrons_robots');
  const before = ((await coll.findOne({ _id: R.id })).protocols ?? []).filter((p) => p.protocolType === PROCESS_TYPE).map((p) => p.opentronsProtocolId);
  const now = new Date();
  await coll.updateOne({ _id: R.id }, { $pull: { protocols: { protocolType: PROCESS_TYPE } } });
  await coll.updateOne({ _id: R.id }, { $push: { protocols: {
    _id: 'op-' + crypto.randomBytes(8).toString('hex'),
    opentronsProtocolId: pid, protocolName: FILE_NAME, protocolType: PROCESS_TYPE,
    parametersSchema: params, analysisStatus: 'completed',
    labwareDefinitions: det.labware ?? null, pipettesRequired: det.pipettes ?? null,
    uploadedBy: ACTOR, createdAt: now, updatedAt: now
  } } });
  await db.collection('audit_log').insertOne({
    _id: 'al-' + crypto.randomBytes(8).toString('hex'),
    tableName: 'opentrons_robots', recordId: R.id, action: 'upload',
    newData: { protocolName: FILE_NAME, protocolType: PROCESS_TYPE, opentronsProtocolId: pid, analysisStatus: 'completed', line: 'lan-script', host },
    changedAt: now, changedBy: ACTOR, reason: `scripts/deploy-diluent-protocol.cjs; replaced ${JSON.stringify(before)}`
  });
  console.log(`  repointed ${R.name}: ${JSON.stringify(before)} -> ["${pid}"]`);
  return { pid, applied: true, host };
}

async function storeActive(db, pyText, deployments) {
  const hash = crypto.createHash('sha256').update(pyText).digest('hex');
  const coll = db.collection('opentrons_protocols');
  const now = new Date();
  let existing = await coll.findOne({ processType: PROCESS_TYPE, fileHash: hash });
  if (existing) {
    if (!existing.isActive) {
      await coll.updateMany({ processType: PROCESS_TYPE, isActive: true, _id: { $ne: existing._id } }, { $set: { isActive: false, updatedAt: now } });
      await coll.updateOne({ _id: existing._id }, { $set: { isActive: true, updatedAt: now } });
      console.log(`stored: re-activated existing ${existing._id} (same hash)`);
    } else console.log(`stored: ${existing._id} already active with this hash`);
  } else {
    const prev = await coll.findOne({ processType: PROCESS_TYPE, isActive: true });
    const _id = 'op-' + crypto.randomBytes(8).toString('hex');
    await coll.insertOne({
      _id, protocolName: STORED_NAME, version: 2,
      description: `${FILE_NAME} — 15 mL Falcon sources (slot 10, A1-A3) into 2 mL tubes in heat-frame racks (slots 7/4/1, 40 each); pipette, tubes/trip, per-tube volume and loaded source volumes are run-time parameters. Deployed by scripts/deploy-diluent-protocol.cjs.`,
      processType: PROCESS_TYPE, fileName: FILE_NAME, fileHash: hash, fileContent: pyText,
      deployments: [], tags: ['diluent'], isActive: true, uploadedBy: ACTOR, createdAt: now, updatedAt: now, __v: 0
    });
    if (prev) await coll.updateOne({ _id: prev._id }, { $set: { isActive: false, updatedAt: now } });
    console.log(`stored: NEW active ${_id} (${STORED_NAME}); previous ${prev ? prev._id : 'none'} deactivated`);
    existing = { _id };
  }
  for (const d of deployments) {
    await coll.updateOne({ _id: existing._id }, { $push: { deployments: {
      _id: 'dp-' + crypto.randomBytes(8).toString('hex'), robotId: d.robotId, robotName: d.robotName,
      opentronsProtocolId: d.pid, analysisStatus: 'completed', deployedAt: now, deployedBy: ACTOR
    } }, $set: { updatedAt: now } });
  }
  return existing._id;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const pyBuf = fs.readFileSync(PROTOCOL);
  const pyText = pyBuf.toString('utf8');
  console.log(`${FILE_NAME} sha256 ${crypto.createHash('sha256').update(pyText).digest('hex').slice(0, 16)}… (${pyText.length} chars); actor ${ACTOR}`);
  const defs = await db.collection('labware_definitions').find({}).project({ fileName: 1, loadName: 1, definition: 1 }).toArray();
  const labware = defs.map((d) => ({ fileName: (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`, json: JSON.stringify(d.definition) }));
  const results = {};
  const deployments = [];
  for (const key of WANT) {
    if (!ROBOTS[key]) { console.log(`unknown robot ${key}`); continue; }
    try {
      results[key] = await deployTo(db, key, labware, pyBuf);
      if (results[key].applied) deployments.push({ robotId: ROBOTS[key].id, robotName: ROBOTS[key].name, pid: results[key].pid });
    } catch (e) { console.log('  ERROR:', e.message); results[key] = { error: e.message }; }
  }
  if (STORE) {
    if (!APPLY) console.log('STORE requested but DEPLOY_APPLY!=1 — not touching the stored protocol');
    else await storeActive(db, pyText, deployments);
  }
  console.log('\nSUMMARY:', JSON.stringify(results));
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
