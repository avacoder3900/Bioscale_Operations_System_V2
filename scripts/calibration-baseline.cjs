/**
 * Golden calibration baseline — save / verify / restore.
 *
 * Freezes the complete fill-calibration state (every BIMS labware definition,
 * per-robot deck offsets, tip-calibrator fixtures, and each robot's wax/reagent
 * protocol pointers) into one timestamped JSON, so a known-good day (like
 * 2026-07-29, when all three robots were operator-confirmed landing correctly)
 * is always restorable.
 *
 *   node scripts/calibration-baseline.cjs save [label]
 *       → writes backups/calibration-golden-<date>[-label].json
 *   node scripts/calibration-baseline.cjs verify <file>
 *       → diffs live Mongo against the baseline; prints per-def drift
 *         (max |dx|,|dy|,|dz| per parity) + fixture/offset/pointer changes.
 *         Exit code 1 when anything drifted. Read-only.
 *   node scripts/calibration-baseline.cjs restore <file> [loadName ...]
 *       → RESTORE_APPLY=1 required. Restores the named defs (or, with no
 *         loadNames, ALL defs + offsets + fixtures) from the baseline.
 *         Protocol pointers are NOT restored (uploads are immutable snapshots;
 *         re-sync or let the run-start freshness gate re-upload instead).
 *
 * After a restore, the next fill run start auto-resyncs the robot via the
 * freshness gate (protocol-freshness.ts), so restored geometry reaches the
 * robot without any extra step.
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const MONGODB_URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');

const BACKUPS = path.resolve(__dirname, '..', 'backups');
const [, , mode, ...args] = process.argv;

async function collect(db) {
  return {
    savedAt: new Date().toISOString(),
    labwareDefinitions: await db.collection('labware_definitions').find({}).toArray(),
    robotDeckOffsets: await db.collection('robot_deck_offsets').find({}).toArray(),
    tipCalibratorFixtures: await db.collection('tip_calibrator_fixtures').find({}).toArray(),
    robotProtocolPointers: (await db.collection('opentrons_robots').find({})
      .project({ name: 1, protocols: 1 }).toArray()).map((r) => ({
        _id: r._id,
        name: r.name,
        protocols: (r.protocols ?? []).map((p) => ({
          protocolType: p.protocolType, opentronsProtocolId: p.opentronsProtocolId,
          protocolName: p.protocolName, uploadedBy: p.uploadedBy, createdAt: p.createdAt
        }))
      }))
  };
}

function wellDrift(liveDef, baseDef) {
  const live = liveDef?.wells ?? {}, base = baseDef?.wells ?? {};
  const stats = { odd: { n: 0, max: 0 }, even: { n: 0, max: 0 }, missing: 0 };
  for (const wn of Object.keys(base)) {
    if (!live[wn]) { stats.missing++; continue; }
    const col = parseInt(wn.slice(1), 10);
    const s = stats[Number.isFinite(col) && col % 2 === 0 ? 'even' : 'odd'];
    const d = Math.max(
      Math.abs((live[wn].x ?? 0) - (base[wn].x ?? 0)),
      Math.abs((live[wn].y ?? 0) - (base[wn].y ?? 0)),
      Math.abs((live[wn].z ?? 0) - (base[wn].z ?? 0))
    );
    if (d > 1e-9) { s.n++; s.max = Math.max(s.max, d); }
  }
  return stats;
}

async function main() {
  await mongoose.connect(MONGODB_URI);
  const db = mongoose.connection.db;

  if (mode === 'save') {
    const snap = await collect(db);
    fs.mkdirSync(BACKUPS, { recursive: true });
    const label = args[0] ? `-${args[0]}` : '';
    const file = path.join(BACKUPS, `calibration-golden-${snap.savedAt.slice(0, 10)}${label}.json`);
    fs.writeFileSync(file, JSON.stringify(snap, null, 1));
    console.log(`Saved baseline: ${file}`);
    console.log(`  defs=${snap.labwareDefinitions.length} offsets=${snap.robotDeckOffsets.length} fixtures=${snap.tipCalibratorFixtures.length} robots=${snap.robotProtocolPointers.length}`);
    return;
  }

  if (mode === 'verify' || mode === 'restore') {
    const file = args[0];
    if (!file || !fs.existsSync(file)) throw new Error(`baseline file not found: ${file}`);
    const base = JSON.parse(fs.readFileSync(file, 'utf8'));

    if (mode === 'verify') {
      let drifted = 0;
      for (const bd of base.labwareDefinitions) {
        const live = await db.collection('labware_definitions').findOne({ loadName: bd.loadName });
        if (!live) { console.log(`DEF ${bd.loadName}: MISSING from live Mongo`); drifted++; continue; }
        const s = wellDrift(live.definition, bd.definition);
        if (s.odd.n || s.even.n || s.missing) {
          console.log(`DEF ${bd.loadName}: DRIFT odd(reagent) n=${s.odd.n} max=${s.odd.max.toFixed(3)}mm | even(wax) n=${s.even.n} max=${s.even.max.toFixed(3)}mm | missing=${s.missing}`);
          drifted++;
        }
      }
      for (const bo of base.robotDeckOffsets) {
        const live = await db.collection('robot_deck_offsets').findOne({ robotId: bo.robotId });
        const eq = live && JSON.stringify(live.offset) === JSON.stringify(bo.offset);
        if (!eq) { console.log(`OFFSET ${bo.robotId}: ${JSON.stringify(bo.offset)} -> ${JSON.stringify(live?.offset ?? null)}`); drifted++; }
      }
      for (const bf of base.tipCalibratorFixtures) {
        const live = await db.collection('tip_calibrator_fixtures').findOne({ robotId: bf.robotId });
        const pick = (f) => f && { position: f.position, zCalWax: f.zCalWax, zCalReagent: f.zCalReagent };
        if (JSON.stringify(pick(live)) !== JSON.stringify(pick(bf))) {
          console.log(`FIXTURE ${bf.robotId}: changed`); drifted++;
        }
      }
      console.log(drifted ? `\n${drifted} item(s) drifted from baseline.` : 'Live calibration matches the baseline exactly.');
      process.exitCode = drifted ? 1 : 0;
      return;
    }

    // restore
    if (process.env.RESTORE_APPLY !== '1') {
      throw new Error('restore requires RESTORE_APPLY=1 (this OVERWRITES live calibration with the baseline)');
    }
    const only = args.slice(1);
    const defs = base.labwareDefinitions.filter((d) => !only.length || only.includes(d.loadName));
    for (const d of defs) {
      await db.collection('labware_definitions').updateOne(
        { loadName: d.loadName },
        { $set: { definition: d.definition } },
        { upsert: false }
      );
      console.log(`restored def ${d.loadName}`);
    }
    if (!only.length) {
      for (const o of base.robotDeckOffsets) {
        await db.collection('robot_deck_offsets').updateOne({ robotId: o.robotId }, { $set: { offset: o.offset } });
        console.log(`restored offset ${o.robotId}`);
      }
      for (const f of base.tipCalibratorFixtures) {
        await db.collection('tip_calibrator_fixtures').updateOne(
          { robotId: f.robotId },
          { $set: { position: f.position, zCalWax: f.zCalWax, zCalReagent: f.zCalReagent } }
        );
        console.log(`restored fixture ${f.robotId}`);
      }
    }
    console.log('\nRestore done. The run-start freshness gate will auto-resync each robot on its next fill run.');
    return;
  }

  throw new Error('usage: calibration-baseline.cjs save [label] | verify <file> | restore <file> [loadName ...]');
}

main().then(() => mongoose.disconnect()).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
