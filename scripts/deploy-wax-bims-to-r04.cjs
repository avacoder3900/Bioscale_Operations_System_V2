/**
 * Deploy the COMMITTED (HEAD) protocols/Wax_Filling_GEN7_Cartridge.py — the
 * BIMS-native lineage — to R04, bundling the Mongo `labware_definitions`.
 *
 * Background (2026-07-28, two live fill attempts converged on this): the wax
 * (EVEN-column) wells of gen4deck_gen7cartridge_001/003/004 needed a HYBRID frame:
 *   - X/Y from the Studio-taught values (operator-observed: those hit the holes;
 *     the app-folder X/Y sent the pipette ~26mm off the holes entirely — no
 *     labware offsets exist on the robot to correct it, verified /labwareOffsets)
 *   - Z from the app-folder values (operator-observed: the taught Z ran ~4-6mm
 *     too deep and snapped tips; app Z "didn't go as deep" = correct height)
 * That hybrid is what now lives in Mongo. ODD (reagent) columns are Studio-taught
 * and untouched. Pre-2026-07-28 state of all four defs:
 *   backups/labware-defs-backup-2026-07-28-pre-waxwell-restore.json
 *
 * Safety gates — will NOT repoint unless the fresh on-robot analysis:
 *   (a) completes with zero errors;
 *   (b) declares the bims_native RTP (right lineage);
 *   (c) resolves every gen4deck_gen7cartridge_001..004 well to the CURRENT
 *       Mongo values, exactly.
 *
 *   node scripts/deploy-wax-bims-to-r04.cjs                 # upload + analyze + verify only
 *   DEPLOY_APPLY=1 node scripts/deploy-wax-bims-to-r04.cjs  # + repoint R04 in Mongo
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const MONGODB_URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const R04_HOST = '172.16.28.144';
const R04_ROBOT_ID = 'CCyX8FjTRGvYOd9vISGvi';
const REPO = path.resolve(__dirname, '..');

const DECKS = ['gen4deck_gen7cartridge_001', 'gen4deck_gen7cartridge_002', 'gen4deck_gen7cartridge_003', 'gen4deck_gen7cartridge_004'];
const H = { 'opentrons-version': '*' };
const APPLY = process.env.DEPLOY_APPLY === '1';

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  // Default: the committed lineage. WAX_PY_REF=worktree ships the working-tree
  // file instead (used 2026-07-28 to deploy the row-boundary batching port:
  // aspirate_remainder RTP so a 2.2/2.2/2.2/1.6 row = 8.2uL fits the 8.5uL trip
  // budget, batches that end on cartridge-row boundaries, and a real lift on any
  // row/cartridge crossing).
  const REF = process.env.WAX_PY_REF || 'HEAD';
  const pyBuf = REF === 'worktree'
    ? fs.readFileSync(path.join(REPO, 'protocols', 'Wax_Filling_GEN7_Cartridge.py'))
    : execSync(`git show ${REF}:protocols/Wax_Filling_GEN7_Cartridge.py`, { cwd: REPO });
  console.log(`Protocol: ${REF === 'worktree' ? 'working tree' : REF}:protocols/Wax_Filling_GEN7_Cartridge.py (${(pyBuf.length / 1024).toFixed(1)} KB)`);

  const defs = await db.collection('labware_definitions')
    .find({}).project({ fileName: 1, loadName: 1, definition: 1 }).toArray();
  const mongoByLoadName = {};
  for (const d of defs) mongoByLoadName[d.loadName] = d.definition;
  const labware = defs.map((d) => {
    const fn = (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`;
    return { fileName: fn, json: JSON.stringify(d.definition) };
  });
  console.log(`Bundling ${labware.length} BIMS labware defs (hybrid wax frame, 2026-07-28)`);

  const form = new FormData();
  form.append('files', new Blob([pyBuf], { type: 'text/x-python' }), 'Wax_Filling_GEN7_Cartridge.py');
  for (const lw of labware) form.append('files', new Blob([lw.json], { type: 'application/json' }), lw.fileName);

  const up = await fetch(`http://${R04_HOST}:31950/protocols`, { method: 'POST', headers: H, body: form, signal: AbortSignal.timeout(120000) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`upload failed ${up.status}: ${JSON.stringify(upBody).slice(0, 300)}`);
  const pid = upBody?.data?.id;
  console.log(`  uploaded protocolId=${pid}`);

  let params = null, analysis = null, status = 'pending';
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const ar = await fetch(`http://${R04_HOST}:31950/protocols/${pid}/analyses`, { headers: H }).then((r) => r.json()).catch(() => null);
    const list = ar?.data ?? [];
    if (!list.length) continue;
    const latest = list[list.length - 1];
    status = latest.status;
    if (status === 'completed') {
      const det = await fetch(`http://${R04_HOST}:31950/protocols/${pid}/analyses/${latest.id}`, { headers: H }).then((r) => r.json()).catch(() => null);
      analysis = det?.data ?? null;
      params = analysis?.runTimeParameters ?? latest?.runTimeParameters ?? null;
      break;
    }
    if (status === 'failed') break;
    process.stdout.write('.');
  }
  console.log(`\n  analysis status=${status}`);
  if (status !== 'completed' || !analysis) throw new Error('analysis did not complete — NOT repointing');
  const errs = analysis.errors ?? [];
  if (errs.length) throw new Error(`analysis errors: ${JSON.stringify(errs).slice(0, 400)}`);

  const names = (params ?? []).map((p) => p.variableName);
  if (!names.includes('bims_native')) throw new Error('bims_native RTP missing — wrong lineage, NOT repointing');
  if (REF === 'worktree' && !names.includes('aspirate_remainder')) {
    throw new Error('aspirate_remainder RTP missing — batching port not in this build, NOT repointing');
  }
  const ar = (params ?? []).find((p) => p.variableName === 'aspirate_remainder');
  console.log(`  params (${names.length}): bims_native present; aspirate_remainder ${ar ? `default=${ar.default}` : 'absent'}`);

  // Geometry gate: the robot's analysis must resolve every carriage well to the
  // CURRENT Mongo values (2026-07-28 frame: wax/even wells = Studio-taught X/Y
  // that physically hit the holes + app-frame Z that stopped the too-deep snap;
  // reagent/odd wells = Studio-taught).
  const loaded = {};
  for (const c of analysis.commands ?? []) {
    if (c.commandType === 'loadLabware' && c.result?.definition?.parameters?.loadName) {
      loaded[c.result.definition.parameters.loadName] = c.result.definition;
    }
  }
  for (const deck of DECKS) {
    const def = loaded[deck];
    if (!def) throw new Error(`analysis did not load ${deck} — NOT repointing`);
    let bad = 0;
    for (const wn of Object.keys(def.wells)) {
      const got = def.wells[wn];
      const want = mongoByLoadName[deck].wells[wn];
      if (Math.abs(got.x - want.x) > 1e-6 || Math.abs(got.y - want.y) > 1e-6 || Math.abs(got.z - want.z) > 1e-6) bad++;
    }
    console.log(`  VERIFY ${deck}: wells-vs-mongo bad=${bad}, X2 x=${def.wells.X2.x} y=${def.wells.X2.y} z=${def.wells.X2.z}`);
    if (bad) throw new Error(`${deck} geometry mismatch vs Mongo — NOT repointing`);
  }

  if (!APPLY) {
    console.log(`\nVERIFY-ONLY. Re-run with DEPLOY_APPLY=1 to repoint R04's wax entry at ${pid}.`);
    await mongoose.disconnect();
    return;
  }

  const coll = db.collection('opentrons_robots');
  const before = ((await coll.findOne({ _id: R04_ROBOT_ID })).protocols ?? []).filter((p) => p.protocolType === 'wax-filling').map((p) => p.opentronsProtocolId);
  console.log(`\n  R04 wax entries BEFORE: ${JSON.stringify(before)}`);
  await coll.updateOne({ _id: R04_ROBOT_ID }, { $pull: { protocols: { protocolType: 'wax-filling' } } });
  await coll.updateOne({ _id: R04_ROBOT_ID }, { $push: { protocols: {
    _id: 'op-' + Math.random().toString(36).slice(2, 18),
    opentronsProtocolId: pid, protocolName: 'Wax_Filling_GEN7_Cartridge.py', protocolType: 'wax-filling',
    parametersSchema: params, analysisStatus: 'completed', labwareDefinitions: null, pipettesRequired: null,
    uploadedBy: 'deploy-wax-bims-to-r04', createdAt: new Date(), updatedAt: new Date()
  } } });
  const after = ((await coll.findOne({ _id: R04_ROBOT_ID })).protocols ?? []).filter((p) => p.protocolType === 'wax-filling').map((p) => p.opentronsProtocolId);
  console.log(`  R04 wax entries AFTER:  ${JSON.stringify(after)}`);
  console.log('\nDONE. R04 BIMS wax runs now use the hybrid wax frame (taught X/Y + app Z).');
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
