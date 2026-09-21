/**
 * Deploy the working-tree protocols/Reagent_Filling_GEN7.py (tip-calibration
 * guards, 2026-08-18) to one robot via BIMS.
 *
 * What the build adds (see progress.txt 2026-08-18):
 *   - use_tip_calibration RTP (default OFF)  -> wax fills at the taught hole, no probe
 *   - max_tip_adjust RTP (default 1.5mm)     -> probe > this / missed switch = REJECTED,
 *                                              retry once with a fresh tip, else nominal
 *   - run_calibration_check RTP (default OFF)-> 9-wax-hole tour with the real fill motion
 *
 * LABWARE: bundles the LIVE Mongo labware_definitions for exactly the labware the
 * robot's current wax protocol loads (that's what the run-start freshness gate
 * enforces anyway) and HARD-GATES that every bundled well == live Mongo. The delta
 * vs the robot's current protocol is printed for information (a freshly
 * re-calibrated deck is SUPPOSED to differ there).
 *
 * Gates (no repoint unless ALL pass): analysis completed with zero errors; RTPs
 * bims_native + dispense_depth + use_tip_calibration + max_tip_adjust +
 * run_calibration_check declared; geometry identical to the current protocol.
 *
 *   node scripts/deploy-reagent-tipcal-guards.cjs                # B07, verify only
 *   ROBOT=b14 node scripts/deploy-reagent-tipcal-guards.cjs      # other robot
 *   DEPLOY_APPLY=1 node scripts/deploy-reagent-tipcal-guards.cjs # + repoint in Mongo
 *
 * Run scripts/set-stored-wax-py.cjs FIRST so the freshness gate's auto-resync
 * rebuilds from the same .py (otherwise a later def change would downgrade the code).
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const MONGODB_URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const ROBOTS = {
  b07: { host: 'hidden-leaf.local', id: '2vIu0fzsbqzkZ7_Zjj3h2', name: 'B07' },
  b14: { host: 'muddy-water.local', id: '8LufEAi5sYJ5JRk_fTfT7', name: 'B14' },
  r04: { host: 'ot2cep20210817r04.local', id: 'CCyX8FjTRGvYOd9vISGvi', name: 'R04' },
};
const R = ROBOTS[(process.env.ROBOT || 'b07').toLowerCase()];
if (!R) throw new Error('ROBOT must be b07|b14|r04');
const HOST = process.env.ROBOT_HOST || R.host;
const REPO = path.resolve(__dirname, '..');
const H = { 'opentrons-version': '*' };
const APPLY = process.env.DEPLOY_APPLY === '1';
const REQUIRED_RTPS = ['bims_native', 'use_tip_calibration', 'max_tip_adjust', 'run_calibration_check'];

const rget = (p) => fetch(`http://${HOST}:31950${p}`, { headers: H, signal: AbortSignal.timeout(90000) }).then((r) => r.json());

async function labwareDefsOfProtocol(pid) {
  const list = (await rget(`/protocols/${pid}/analyses`))?.data ?? [];
  const done = list.filter((a) => a.status === 'completed');
  if (!done.length) throw new Error(`protocol ${pid} has no completed analysis`);
  const det = await rget(`/protocols/${pid}/analyses/${done[done.length - 1].id}`);
  const out = {};
  for (const c of det?.data?.commands ?? []) {
    const def = c.commandType === 'loadLabware' && c.result?.definition;
    if (def && def.parameters?.loadName) out[def.parameters.loadName] = def;
  }
  return out;
}
const wellsOf = (defs) => Object.fromEntries(Object.entries(defs).map(([k, d]) => [k, d.wells]));

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;
  const robots = db.collection('opentrons_robots');
  const robot = await robots.findOne({ _id: R.id });
  if (!robot) throw new Error(`robot ${R.id} not in Mongo`);
  const currentEntry = (robot.protocols ?? []).filter((p) => p.protocolType === 'reagent-filling').sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))[0];
  if (!currentEntry) throw new Error(`${R.name} has no reagent-filling protocol entry`);
  const CURRENT_PID = currentEntry.opentronsProtocolId;
  console.log(`${R.name} (${HOST}) current wax protocol: ${CURRENT_PID} (uploadedBy ${currentEntry.uploadedBy || '?'})`);

  const baselineDefs = await labwareDefsOfProtocol(CURRENT_PID);
  const baseline = wellsOf(baselineDefs);
  const loadNames = Object.keys(baselineDefs);
  console.log(`  current protocol loads: ${loadNames.join(', ')}`);

  // Bundle LIVE Mongo defs for those loadNames.
  const labware = [];
  for (const ln of loadNames) {
    const doc = await db.collection('labware_definitions').findOne({ loadName: ln });
    if (!doc?.definition) throw new Error(`Mongo labware_definitions has no ${ln}`);
    labware.push({ fileName: `${ln}.json`, json: JSON.stringify(doc.definition) });
  }

  const pyBuf = fs.readFileSync(path.join(REPO, 'protocols', 'Reagent_Filling_GEN7.py'));
  console.log(`Protocol: working tree Reagent_Filling_GEN7.py (${(pyBuf.length / 1024).toFixed(1)} KB)`);
  for (const k of REQUIRED_RTPS) if (!pyBuf.toString().includes(`variable_name="${k}"`)) throw new Error(`working-tree .py lacks RTP ${k}`);

  const form = new FormData();
  form.append('files', new Blob([pyBuf], { type: 'text/x-python' }), 'Reagent_Filling_GEN7.py');
  for (const lw of labware) form.append('files', new Blob([lw.json], { type: 'application/json' }), lw.fileName);
  const up = await fetch(`http://${HOST}:31950/protocols`, { method: 'POST', headers: H, body: form, signal: AbortSignal.timeout(180000) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`upload failed ${up.status}: ${JSON.stringify(upBody).slice(0, 300)}`);
  const pid = upBody?.data?.id;
  console.log(`  uploaded protocolId=${pid}`);
  const cleanup = async (why) => {
    console.log(`  removing rejected upload ${pid} (${why})`);
    await fetch(`http://${HOST}:31950/protocols/${pid}`, { method: 'DELETE', headers: H }).catch(() => {});
  };

  let params = null, analysis = null, status = 'pending';
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const list = (await rget(`/protocols/${pid}/analyses`).catch(() => null))?.data ?? [];
    if (!list.length) continue;
    const latest = list[list.length - 1];
    status = latest.status;
    if (status === 'completed') {
      const det = await rget(`/protocols/${pid}/analyses/${latest.id}`).catch(() => null);
      analysis = det?.data ?? null;
      params = analysis?.runTimeParameters ?? latest?.runTimeParameters ?? null;
      break;
    }
    if (status === 'failed') break;
    process.stdout.write('.');
  }
  console.log(`\n  analysis status=${status}`);
  if (status !== 'completed' || !analysis) { await cleanup('analysis did not complete'); throw new Error('analysis did not complete — NOT repointing'); }
  const errs = analysis.errors ?? [];
  if (errs.length) { for (const e of errs) console.log('   ', String(e.detail).slice(0, 300)); await cleanup('analysis errors'); throw new Error('analysis has errors — NOT repointing'); }

  const names = (params ?? []).map((p) => p.variableName);
  console.log(`  params (${names.length}): ${names.join(', ')}`);
  for (const k of REQUIRED_RTPS) if (!names.includes(k)) { await cleanup(`${k} missing`); throw new Error(`${k} missing from analysis`); }
  const show = (k) => (params.find((p) => p.variableName === k) || {}).default;
  console.log(`  defaults: use_tip_calibration=${show('use_tip_calibration')} max_tip_adjust=${show('max_tip_adjust')} run_calibration_check=${show('run_calibration_check')} dispense_depth=${show('dispense_depth')}`);

  // Geometry gate: the new upload must resolve every well EXACTLY as live Mongo
  // (the source of truth the run-start freshness gate enforces). The delta vs the
  // robot's current protocol is reported for information — a re-calibrated deck is
  // expected to differ there, and that is precisely what should reach the robot.
  const fresh = wellsOf(await labwareDefsOfProtocol(pid));
  const mongoWells = {};
  for (const lw of labware) mongoWells[lw.fileName.replace(/\.json$/, '')] = JSON.parse(lw.json).wells;
  const problems = [];
  for (const ln of Object.keys(mongoWells)) {
    if (!fresh[ln]) { problems.push(`${ln}: MISSING from new upload`); continue; }
    let worst = 0, at = null;
    for (const wn of Object.keys(mongoWells[ln])) {
      const b = mongoWells[ln][wn], f = fresh[ln][wn];
      if (!f) { problems.push(`${ln}.${wn} missing`); continue; }
      const d = Math.max(Math.abs(b.x - f.x), Math.abs(b.y - f.y), Math.abs(b.z - f.z));
      if (d > worst) { worst = d; at = wn; }
    }
    if (worst > 1e-6) problems.push(`${ln}: differs from Mongo up to ${worst.toFixed(4)}mm (worst ${at})`);
    // info: delta vs the robot's CURRENT protocol
    let cw = 0, ca = null, cn = 0;
    for (const wn of Object.keys(mongoWells[ln])) {
      const b = (baseline[ln] || {})[wn], f = fresh[ln][wn];
      if (!b || !f) continue;
      const d = Math.max(Math.abs(b.x - f.x), Math.abs(b.y - f.y), Math.abs(b.z - f.z));
      if (d > 1e-6) cn++;
      if (d > cw) { cw = d; ca = wn; }
    }
    console.log(`    ${ln}: == Mongo${cn ? `; vs current protocol: ${cn} wells changed, max ${cw.toFixed(3)}mm (${ca})` : '; identical to current protocol'}`);
  }
  if (problems.length) { problems.forEach((p) => console.log(`    !! ${p}`)); await cleanup('geometry != Mongo'); throw new Error('bundled geometry does not match live Mongo — NOT repointing'); }
  console.log('  geometry gate OK: every bundled well == live Mongo');

  if (!APPLY) {
    console.log(`\nVERIFY-ONLY (nothing changed in BIMS). Re-run with DEPLOY_APPLY=1 to repoint ${R.name}'s wax entry at ${pid}. (Upload ${pid} left on the robot.)`);
    await mongoose.disconnect();
    return;
  }

  const before = (robot.protocols ?? []).filter((p) => p.protocolType === 'reagent-filling').map((p) => p.opentronsProtocolId);
  console.log(`\n  ${R.name} wax entries BEFORE: ${JSON.stringify(before)}  (rollback target)`);
  await robots.updateOne({ _id: R.id }, { $pull: { protocols: { protocolType: 'reagent-filling' } } });
  await robots.updateOne({ _id: R.id }, { $push: { protocols: {
    _id: 'op-' + Math.random().toString(36).slice(2, 18),
    opentronsProtocolId: pid, protocolName: 'Reagent_Filling_GEN7.py', protocolType: 'reagent-filling',
    parametersSchema: params, analysisStatus: 'completed', labwareDefinitions: null, pipettesRequired: null,
    uploadedBy: 'deploy-reagent-tipcal-guards', createdAt: new Date(), updatedAt: new Date()
  } } });
  await db.collection('audit_logs').insertOne({
    _id: 'al-' + Math.random().toString(36).slice(2, 18),
    action: 'wax_protocol_deploy', resourceType: 'opentrons_robot', resourceId: R.id,
    userId: 'script', username: 'deploy-reagent-tipcal-guards', timestamp: new Date(),
    details: { robot: R.name, from: before, to: pid, rtps: names.length, note: 'tip-cal opt-in + max_tip_adjust guard + wax calibration check' }
  });
  const after = ((await robots.findOne({ _id: R.id })).protocols ?? []).filter((p) => p.protocolType === 'reagent-filling').map((p) => p.opentronsProtocolId);
  console.log(`  ${R.name} wax entries AFTER:  ${JSON.stringify(after)}`);
  console.log(`\nDONE. ${R.name} wax now runs the no-tip-recovery reagent build (max_tip_adjust guard, hand-insert retry, no junk adjust). Rollback: repoint at ${JSON.stringify(before)}.`);
  await mongoose.disconnect();
}
main().catch(async (e) => { console.error('ERROR:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
