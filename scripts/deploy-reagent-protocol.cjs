/**
 * Deploy the repo's protocols/Reagent_Filling_GEN7.py to the robots + make it the
 * stored active reagent protocol in BIMS (what the run-start freshness gate
 * re-uploads). Generalised from deploy-reagent-to-{b07,b14,r04}.cjs (2026-10-12,
 * bump-recovery rollout).
 *
 * Per robot: upload the .py + every BIMS labware def (Mongo `labware_definitions`,
 * the Studio-corrected geometry) straight to the robot's HTTP API (works over the
 * LAN or Tailscale — no bridge/internet needed), wait for analysis, gate on it
 * completing with the expected RTPs, then repoint opentrons_robots.protocols[]'s
 * reagent-filling entry. Robots with a live BIMS wax/reagent run are SKIPPED
 * (never swap the protocol under a run) — re-run later for them.
 *
 *   node scripts/deploy-reagent-protocol.cjs                        # verify only, all robots
 *   DEPLOY_APPLY=1 node scripts/deploy-reagent-protocol.cjs         # apply to all idle robots
 *   DEPLOY_APPLY=1 ROBOTS=b14 node scripts/deploy-reagent-protocol.cjs   # one robot
 *   STORE=1 adds/updates the stored active OpentronProtocol (idempotent on hash)
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const MONGODB_URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const ROBOTS = {
  b07: { id: '2vIu0fzsbqzkZ7_Zjj3h2', hosts: ['100.109.115.63', '172.16.202.123'], name: 'B07' },
  r04: { id: 'CCyX8FjTRGvYOd9vISGvi', hosts: ['100.88.240.14', '172.16.202.124'], name: 'R04' },
  b14: { id: '8LufEAi5sYJ5JRk_fTfT7', hosts: ['100.122.230.39', '172.16.202.117'], name: 'B14' }
};
const PROTOCOL = path.resolve(__dirname, '..', 'protocols', 'Reagent_Filling_GEN7.py');
const H = { 'opentrons-version': '*' };
const APPLY = process.env.DEPLOY_APPLY === '1';
const STORE = process.env.STORE === '1';
const WANT = (process.env.ROBOTS || 'b07,r04,b14').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const REQUIRED_RTPS = ['use_tip_calibration', 'tube_rack', 'bims_native'];
const STORED_NAME = process.env.STORED_NAME || 'Reagent Filling GEN7 (tip swap + tube-rack + bump recovery)';

async function reachable(hosts) {
  for (const h of hosts) {
    try {
      const r = await fetch(`http://${h}:31950/health`, { headers: H, signal: AbortSignal.timeout(6000) });
      if (r.ok) return h;
    } catch { /* next */ }
  }
  return null;
}

async function deployTo(db, key, labware, pyBuf) {
  const R = ROBOTS[key];
  // ALLOW_LOADING=1: a run still in Setup/Loading has no robot run yet (it is
  // created at Start from the robot's CURRENT protocol entry), so repointing is
  // safe when the RTP schema is unchanged. Default = strict.
  const blocking = process.env.ALLOW_LOADING === '1' ? ['Running', 'running'] : ['Running', 'Loading', 'Setup', 'running', 'setup'];
  const live = await db.collection('reagent_batch_records').findOne({ 'robot._id': R.id, status: { $in: blocking } }, { projection: { _id: 1, status: 1 } });
  const liveWax = await db.collection('wax_filling_runs').findOne({ 'robot._id': R.id, status: { $in: ['Running', 'running', 'Setup', 'Loading', 'AwaitingRemoval', 'PostRunCooling'] } }, { projection: { _id: 1, status: 1 } });
  if (live || liveWax) {
    console.log(`\n[${R.name}] SKIPPED — live run on this robot (${live ? 'reagent ' + live._id + ' ' + live.status : 'wax ' + liveWax._id + ' ' + liveWax.status}). Re-run after it finishes.`);
    return { skipped: true };
  }
  const host = await reachable(R.hosts);
  if (!host) { console.log(`\n[${R.name}] SKIPPED — unreachable on ${R.hosts.join(' / ')}`); return { skipped: true }; }
  console.log(`\n[${R.name}] uploading ${path.basename(PROTOCOL)} (${(pyBuf.length / 1024).toFixed(1)} KB) + ${labware.length} labware defs via ${host}`);
  const form = new FormData();
  form.append('files', new Blob([pyBuf], { type: 'text/x-python' }), 'Reagent_Filling_GEN7.py');
  for (const lw of labware) form.append('files', new Blob([lw.json], { type: 'application/json' }), lw.fileName);
  const up = await fetch(`http://${host}:31950/protocols`, { method: 'POST', headers: H, body: form, signal: AbortSignal.timeout(180000) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`[${R.name}] upload failed ${up.status}: ${JSON.stringify(upBody).slice(0, 300)}`);
  const pid = upBody?.data?.id;
  console.log(`  protocolId=${pid}`);

  let params = null, status = 'pending';
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const ar = await fetch(`http://${host}:31950/protocols/${pid}/analyses`, { headers: H, signal: AbortSignal.timeout(15000) }).then((r) => r.json()).catch(() => null);
    const list = ar?.data ?? [];
    if (!list.length) continue;
    const latest = list[list.length - 1];
    status = latest.status;
    if (status === 'completed') {
      const det = await fetch(`http://${host}:31950/protocols/${pid}/analyses/${latest.id}`, { headers: H, signal: AbortSignal.timeout(30000) }).then((r) => r.json()).catch(() => null);
      params = det?.data?.runTimeParameters ?? latest?.runTimeParameters ?? null;
      const errs = det?.data?.errors ?? [];
      if (errs.length) { console.log('  ANALYSIS ERRORS:', JSON.stringify(errs).slice(0, 400)); throw new Error(`[${R.name}] analysis reported errors — NOT repointing`); }
      break;
    }
    if (status === 'failed') break;
    process.stdout.write('.');
  }
  console.log(`\n  analysis status=${status}`);
  if (status !== 'completed') throw new Error(`[${R.name}] analysis did not complete — NOT repointing`);
  const names = (params ?? []).map((p) => p.variableName);
  const missing = REQUIRED_RTPS.filter((n) => !names.includes(n));
  console.log(`  RTPs (${names.length}); required present: ${missing.length ? 'MISSING ' + missing.join(',') : 'yes'}`);
  if (missing.length) throw new Error(`[${R.name}] expected RTPs missing — NOT repointing`);
  if (!APPLY) { console.log(`  VERIFY-ONLY — re-run with DEPLOY_APPLY=1 to repoint ${R.name} at ${pid}`); return { pid, verified: true }; }

  const coll = db.collection('opentrons_robots');
  const before = ((await coll.findOne({ _id: R.id })).protocols ?? []).filter((p) => p.protocolType === 'reagent-filling').map((p) => p.opentronsProtocolId);
  await coll.updateOne({ _id: R.id }, { $pull: { protocols: { protocolType: 'reagent-filling' } } });
  await coll.updateOne({ _id: R.id }, { $push: { protocols: {
    _id: 'op-' + crypto.randomBytes(8).toString('hex'),
    opentronsProtocolId: pid, protocolName: 'Reagent_Filling_GEN7.py', protocolType: 'reagent-filling',
    parametersSchema: params, analysisStatus: 'completed', labwareDefinitions: null, pipettesRequired: null,
    uploadedBy: 'deploy-reagent-protocol', createdAt: new Date(), updatedAt: new Date()
  } } });
  console.log(`  repointed ${R.name}: ${JSON.stringify(before)} -> ["${pid}"]`);
  return { pid, applied: true };
}

async function storeActive(db, pyText) {
  const hash = crypto.createHash('sha256').update(pyText).digest('hex');
  const coll = db.collection('opentrons_protocols');
  const existing = await coll.findOne({ processType: 'reagent-filling', fileHash: hash });
  if (existing) {
    if (!existing.isActive) {
      await coll.updateMany({ processType: 'reagent-filling', isActive: true, _id: { $ne: existing._id } }, { $set: { isActive: false, updatedAt: new Date() } });
      await coll.updateOne({ _id: existing._id }, { $set: { isActive: true, updatedAt: new Date() } });
      console.log(`stored: re-activated existing ${existing._id} (same hash)`);
    } else console.log(`stored: ${existing._id} already active with this hash`);
    return existing._id;
  }
  const prev = await coll.findOne({ processType: 'reagent-filling', isActive: true });
  const _id = 'op-' + crypto.randomBytes(8).toString('hex');
  const now = new Date();
  await coll.insertOne({
    _id, protocolName: STORED_NAME,
    description: 'Reagent_Filling_GEN7.py — mid-run tip swap (rack/hand), per-run tube-rack choice, and BUMP RECOVERY (home + re-probe the same tip, continue at the interrupted well). Deployed by scripts/deploy-reagent-protocol.cjs.',
    processType: 'reagent-filling', fileName: 'Reagent_Filling_GEN7.py', fileHash: hash, fileContent: pyText,
    tags: prev?.tags ?? [], isActive: true, uploadedBy: 'deploy-reagent-protocol', createdAt: now, updatedAt: now, __v: 0
  });
  if (prev) await coll.updateOne({ _id: prev._id }, { $set: { isActive: false, updatedAt: now } });
  console.log(`stored: NEW active ${_id} (${STORED_NAME}); previous ${prev ? prev._id : 'none'} deactivated`);
  return _id;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const pyBuf = fs.readFileSync(PROTOCOL);
  const pyText = pyBuf.toString('utf8');
  console.log(`protocol sha256 ${crypto.createHash('sha256').update(pyText).digest('hex').slice(0, 16)}… (${pyText.length} chars)`);
  if (STORE) {
    if (!APPLY) console.log('STORE requested but DEPLOY_APPLY!=1 — not touching the stored protocol');
    else await storeActive(db, pyText);
  }
  const defs = await db.collection('labware_definitions').find({}).project({ fileName: 1, loadName: 1, definition: 1 }).toArray();
  const labware = defs.map((d) => ({ fileName: (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`, json: JSON.stringify(d.definition) }));
  const results = {};
  for (const key of WANT) {
    if (!ROBOTS[key]) { console.log(`unknown robot ${key}`); continue; }
    try { results[key] = await deployTo(db, key, labware, pyBuf); }
    catch (e) { console.log('  ERROR:', e.message); results[key] = { error: e.message }; }
  }
  console.log('\nSUMMARY:', JSON.stringify(results));
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
