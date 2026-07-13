/**
 * One-off: deploy the CURRENT repo protocols/Wax_Filling_GEN7_Cartridge.py to R04 only
 * (adds the `use_tip_calibration` RTP, default OFF — the per-tip limit-switch bend probe
 * and its 'C' offset baseline read are both skipped when it's off, so the run dispenses at
 * the nominal well position). Mirrors deploy-reagent-to-r04.cjs.
 *
 * Bundles the BIMS-managed labware definitions (Mongo `labware_definitions`) — the SAME
 * source robotUploadProtocol uses and where the Deck Calibration Studio writes its
 * jog-to-teach corrections. (Bundling the local Opentrons app folder ships stale deck
 * geometry -> the run lands ~30mm off.)
 *
 * Then surgically repoint R04's opentrons_robots.protocols[] wax-filling entry at the fresh
 * upload (pull all wax entries, push exactly one).
 *
 * NOTE: this does NOT remove the calibrator from the run — wax still reads the deck/particle
 * ID from it over serial ('I'), which is how it knows WHICH deck labware to load. Only the
 * tip-bend probe is switched off. Same as reagent.
 *
 * Safety gate: will NOT write to Mongo unless the fresh on-robot analysis both
 * (a) completes and (b) exposes the `use_tip_calibration` run-time parameter with default=false.
 *
 *   node scripts/deploy-wax-to-r04.cjs                 # upload + analyze + verify only
 *   DEPLOY_APPLY=1 node scripts/deploy-wax-to-r04.cjs  # + repoint R04 in Mongo
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const MONGODB_URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const R04_HOST = '172.16.28.144';
const R04_ROBOT_ID = 'CCyX8FjTRGvYOd9vISGvi';
const PROTOCOL = path.resolve(__dirname, '..', 'protocols', 'Wax_Filling_GEN7_Cartridge.py');
const PROTOCOL_NAME = 'Wax_Filling_GEN7_Cartridge.py';
const PROTOCOL_TYPE = 'wax-filling';
const H = { 'opentrons-version': '*' };
const APPLY = process.env.DEPLOY_APPLY === '1';

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  const defs = await db.collection('labware_definitions')
    .find({}).project({ fileName: 1, loadName: 1, definition: 1 }).toArray();
  const labware = defs.map((d) => {
    const fn = (d.fileName && String(d.fileName).endsWith('.json')) ? String(d.fileName) : `${d.loadName}.json`;
    return { fileName: fn, json: JSON.stringify(d.definition) };
  });
  console.log(`Bundling ${labware.length} BIMS labware defs (Studio-corrected geometry)`);

  const pyBuf = fs.readFileSync(PROTOCOL);
  console.log(`Uploading ${PROTOCOL_NAME} (${(pyBuf.length / 1024).toFixed(1)} KB) to R04 ${R04_HOST}`);
  const form = new FormData();
  form.append('files', new Blob([pyBuf], { type: 'text/x-python' }), PROTOCOL_NAME);
  for (const lw of labware) form.append('files', new Blob([lw.json], { type: 'application/json' }), lw.fileName);

  const up = await fetch(`http://${R04_HOST}:31950/protocols`, { method: 'POST', headers: H, body: form, signal: AbortSignal.timeout(120000) });
  const upBody = await up.json();
  if (!up.ok) throw new Error(`upload failed ${up.status}: ${JSON.stringify(upBody).slice(0, 300)}`);
  const pid = upBody?.data?.id;
  console.log(`  uploaded protocolId=${pid}`);

  let params = null, status = 'pending';
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 3000));
    const ar = await fetch(`http://${R04_HOST}:31950/protocols/${pid}/analyses`, { headers: H }).then((r) => r.json()).catch(() => null);
    const list = ar?.data ?? [];
    if (!list.length) continue;
    const latest = list[list.length - 1];
    status = latest.status;
    if (status === 'completed') {
      const det = await fetch(`http://${R04_HOST}:31950/protocols/${pid}/analyses/${latest.id}`, { headers: H }).then((r) => r.json()).catch(() => null);
      params = det?.data?.runTimeParameters ?? latest?.runTimeParameters ?? null;
      const errs = det?.data?.errors ?? [];
      if (errs.length) console.log('  analysis errors:', JSON.stringify(errs).slice(0, 300));
      break;
    }
    if (status === 'failed') break;
    process.stdout.write('.');
  }
  console.log(`\n  analysis status=${status}`);
  if (status !== 'completed') throw new Error('analysis did not complete — NOT repointing');

  const names = (params ?? []).map((p) => p.variableName);
  const toggleDef = (params ?? []).find((p) => p.variableName === 'use_tip_calibration');
  console.log(`  params (${names.length}): use_tip_calibration present = ${!!toggleDef}, default = ${toggleDef && toggleDef.default}`);
  if (!toggleDef) throw new Error('use_tip_calibration not in analysis — NOT repointing');
  if (toggleDef.default !== false) throw new Error(`use_tip_calibration default is ${toggleDef.default}, expected false — NOT repointing`);

  // The resume RTPs ship on this same build; make sure they survived the upload too.
  for (const need of ['resume_cartridge', 'resume_hole']) {
    console.log(`  ${need} present = ${names.includes(need)}`);
  }

  if (!APPLY) {
    console.log(`\nVERIFY-ONLY. Re-run with DEPLOY_APPLY=1 to repoint R04's wax entry at ${pid}.`);
    await mongoose.disconnect();
    return;
  }

  const coll = db.collection('opentrons_robots');
  const before = ((await coll.findOne({ _id: R04_ROBOT_ID })).protocols ?? []).filter((p) => p.protocolType === PROTOCOL_TYPE).map((p) => p.opentronsProtocolId);
  console.log(`\n  R04 wax entries BEFORE: ${JSON.stringify(before)}`);
  await coll.updateOne({ _id: R04_ROBOT_ID }, { $pull: { protocols: { protocolType: PROTOCOL_TYPE } } });
  await coll.updateOne({ _id: R04_ROBOT_ID }, { $push: { protocols: {
    _id: 'op-' + Math.random().toString(36).slice(2, 18),
    opentronsProtocolId: pid, protocolName: PROTOCOL_NAME, protocolType: PROTOCOL_TYPE,
    parametersSchema: params, analysisStatus: 'completed', labwareDefinitions: null, pipettesRequired: null,
    uploadedBy: 'deploy-wax-to-r04', createdAt: new Date(), updatedAt: new Date()
  } } });
  const after = ((await coll.findOne({ _id: R04_ROBOT_ID })).protocols ?? []).filter((p) => p.protocolType === PROTOCOL_TYPE).map((p) => p.opentronsProtocolId);
  console.log(`  R04 wax entries AFTER:  ${JSON.stringify(after)}`);
  console.log('\nDONE. R04 wax run now has USE TIP CALIBRATION (default OFF) + Studio-correct deck geometry.');
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
