/**
 * Re-key tip_calibrator_fixtures from ROBOT to DECK (2026-08-28).
 *
 * WHY: the calibrator is bolted to the cartridge carriage, so it travels with the
 * DECK — but the collection was keyed `robotId: unique`, one row per robot. When
 * B14 was moved onto the robot-arm deck on 08-21, the arm rig's fixture point
 * (294.88, 79.24, z 23.85) overwrote the reagent deck's (125.181, 173.247, 38.5)
 * — 194mm away, probe Z 17mm low — and swapping back left B14 pointing at a
 * fixture that was no longer there. Keying by deck makes the swap non-destructive
 * in both directions.
 *
 * KEY: `deckKey` = the carriage's Particle device id, which is what the .py reads
 * at run start to choose the deck definition. Same identity for geometry and
 * calibrator, so they cannot disagree. `deckLoadName` is carried for humans.
 *
 * WHAT IT DOES (idempotent, dry-run by default):
 *   1. For each existing robot-keyed row, stamp it with the deck that robot
 *      currently runs (PAIRS below) — B07→004, R04→001.
 *   2. B14's row currently holds the ROBOT-ARM values. It is split in two:
 *        • the arm values move to a row for robotarm_cartridge_deck_001
 *        • deck-003 gets a row restored from that doc's own history — the
 *          07-20 entry (125.181, 173.247, 38.5 / zCalReagent 40.8), i.e. the
 *          value in force for every good B14 reagent run through 08-14.
 *   3. Nothing is deleted; every write records its provenance in `history`.
 *
 *   node scripts/migrate-calibrator-to-deck.cjs           # plan only
 *   APPLY=1 node scripts/migrate-calibrator-to-deck.cjs   # write
 */
const fs = require('fs');
const mongoose = require('/Users/brevitest/Bioscale_Operations_System_V2/node_modules/mongoose');

const URI = fs.readFileSync('/Users/brevitest/Bioscale_Operations_System_V2/.env', 'utf8')
  .split('\n').find((l) => l.trim().startsWith('MONGODB_URI'))
  .split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
const APPLY = process.env.APPLY === '1';

// The deck each robot physically runs for FILLING (confirmed with the operator
// 2026-08-28: deck-001/R04 and deck-004/B07 are dialled in; deck-003 is B14's).
const PAIRS = {
  '2vIu0fzsbqzkZ7_Zjj3h2': 'gen4deck_gen7cartridge_004', // B07
  CCyX8FjTRGvYOd9vISGvi: 'gen4deck_gen7cartridge_001',   // R04
  '8LufEAi5sYJ5JRk_fTfT7': 'gen4deck_gen7cartridge_003'  // B14
};
const ARM_DECK = 'robotarm_cartridge_deck_001';
const nano = () => {
  const a = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-';
  let s = ''; for (let i = 0; i < 21; i++) s += a[Math.floor(Math.random() * a.length)];
  return s;
};

(async () => {
  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const fixtures = db.collection('tip_calibrator_fixtures');
  const equipment = db.collection('equipment');

  const deckKeyFor = async (loadName) => {
    const e = await equipment.findOne({ equipmentType: 'deck', deckLoadName: loadName });
    return e?.particleDeviceId ?? null;
  };

  // The old `robotId: unique` index lives in Mongo, not in the schema file — a
  // model change does not remove it, and it is exactly what blocks a robot from
  // having one calibrator per deck. Drop it (idempotent).
  const idx = await fixtures.indexes();
  const stale = idx.find((i) => i.name === 'robotId_1' && i.unique);
  if (stale) {
    console.log('stale unique index robotId_1 present — ' + (APPLY ? 'dropping' : 'would drop'));
    if (APPLY) {
      await fixtures.dropIndex('robotId_1');
      await fixtures.createIndex({ robotId: 1 });
      await fixtures.createIndex({ deckKey: 1 }, { unique: true, partialFilterExpression: { deckKey: { $type: 'string' } } });
      await fixtures.createIndex({ deckLoadName: 1 });
    }
  }

  const rows = await fixtures.find({}).toArray();
  console.log(`existing fixture rows: ${rows.length}`);
  const plan = [];

  for (const row of rows) {
    if (row.deckKey || row.deckLoadName) { console.log(`  ${row._id}: already re-keyed (${row.deckLoadName}) — skip`); continue; }
    const robotId = String(row.robotId);
    const loadName = PAIRS[robotId];
    if (!loadName) { console.log(`  ${row._id}: robot ${robotId} has no known deck pairing — leaving as legacy`); continue; }

    // B14 is the split case: its CURRENT values describe the robot-arm rig.
    const isArmValues = robotId === '8LufEAi5sYJ5JRk_fTfT7'
      && row.referenceHole?.deckLoadName === ARM_DECK;

    if (!isArmValues) {
      plan.push({
        kind: 'stamp',
        _id: row._id,
        loadName,
        deckKey: await deckKeyFor(loadName),
        note: `re-keyed to the deck this robot runs (${loadName})`
      });
      continue;
    }

    // 1) the arm values become the ARM deck's own row
    plan.push({
      kind: 'stamp',
      _id: row._id,
      loadName: ARM_DECK,
      deckKey: await deckKeyFor(ARM_DECK),
      note: 'these values were taught against the robot-arm rig on 2026-08-21 — they belong to the arm deck, not to B14'
    });

    // 2) deck-003 gets its pre-arm value back, from this doc's own history
    // Oldest matching entry = the original pre-arm teach (jacob, 07-20), which
    // gives the truest provenance note; the values are identical in every
    // matching snapshot.
    const matches = (row.history ?? []).filter(
      (h) => Math.abs((h?.position?.x ?? 0) - 125.181) < 0.5 && Math.abs((h?.position?.y ?? 0) - 173.247) < 0.5
    );
    const restored = matches.length ? matches[matches.length - 1] : null;
    if (!restored) { console.log('  !! no pre-arm history entry found for B14 — deck-003 row NOT created'); continue; }
    plan.push({
      kind: 'create',
      loadName,
      deckKey: await deckKeyFor(loadName),
      robotId,
      position: restored.position,
      zCalWax: restored.zCalWax ?? 34.491,
      zCalReagent: restored.zCalReagent ?? 40.8,
      note: `restored from the fixture's own history (captured ${new Date(restored.capturedAt).toISOString().slice(0, 16)}) — the point in force for every good B14 reagent run through 08-14, before the robot-arm session overwrote it`
    });
  }

  // The arm split leaves B14's own deck without a row until we recreate it from
  // the arm row's history. Runs whether or not the stamp happened this pass.
  const armRow = await fixtures.findOne({ deckLoadName: ARM_DECK });
  const b14Deck = PAIRS['8LufEAi5sYJ5JRk_fTfT7'];
  if (armRow && !(await fixtures.findOne({ deckLoadName: b14Deck }))) {
    const matches = (armRow.history ?? []).filter(
      (h) => Math.abs((h?.position?.x ?? 0) - 125.181) < 0.5 && Math.abs((h?.position?.y ?? 0) - 173.247) < 0.5
    );
    const restored = matches.length ? matches[matches.length - 1] : null;
    if (!restored) console.log('  !! no pre-arm history entry on the arm row — ' + b14Deck + ' row NOT created');
    else plan.push({
      kind: 'create',
      loadName: b14Deck,
      deckKey: await deckKeyFor(b14Deck),
      robotId: String(armRow.robotId),
      position: restored.position,
      zCalWax: restored.zCalWax ?? 34.491,
      zCalReagent: restored.zCalReagent ?? 40.8,
      note: `restored from the fixture's own history (captured ${new Date(restored.capturedAt).toISOString().slice(0, 16)}) — the point in force for every good B14 reagent run through 08-14, before the robot-arm session overwrote it`
    });
  }

  for (const p of plan) {
    console.log(`  ${p.kind.toUpperCase()} ${p.loadName} (deckKey ${p.deckKey ?? 'NONE — will key by loadName'})`
      + (p.position ? ` pos (${p.position.x}, ${p.position.y}, ${p.position.z}) zReag ${p.zCalReagent}` : '')
      + `\n      ${p.note}`);
  }
  if (!plan.length) { console.log('nothing to do'); await mongoose.disconnect(); return; }
  if (!APPLY) { console.log('\nDRY RUN — APPLY=1 to write.'); await mongoose.disconnect(); return; }

  const now = new Date();
  for (const p of plan) {
    if (p.kind === 'stamp') {
      await fixtures.updateOne({ _id: p._id }, { $set: { deckKey: p.deckKey, deckLoadName: p.loadName, updatedAt: now } });
    } else {
      await fixtures.insertOne({
        _id: nano(),
        deckKey: p.deckKey,
        deckLoadName: p.loadName,
        robotId: p.robotId,
        position: p.position,
        zCalWax: p.zCalWax,
        zCalReagent: p.zCalReagent,
        capturedBy: { username: 'migrate-calibrator-to-deck (req: alejandrov)' },
        capturedAt: now,
        history: [],
        note: p.note
      });
    }
    await db.collection('audit_logs').insertOne({
      _id: nano(), tableName: 'tip_calibrator_fixtures', recordId: String(p._id ?? p.deckKey ?? p.loadName),
      action: 'calibrator_rekey_to_deck', changedAt: now, changedBy: 'migrate-calibrator-to-deck',
      newData: { kind: p.kind, deckLoadName: p.loadName, deckKey: p.deckKey, note: p.note }
    });
  }

  console.log('\nAPPLIED. Final state:');
  for (const r of await fixtures.find({}).sort({ deckLoadName: 1 }).toArray()) {
    console.log(`  ${r.deckLoadName ?? '(legacy robot row)'} key=${r.deckKey ?? '-'} robot=${r.robotId} `
      + `pos (${r.position?.x}, ${r.position?.y}, ${r.position?.z}) zWax ${r.zCalWax} zReag ${r.zCalReagent}`);
  }
  await mongoose.disconnect();
})().catch(async (e) => { console.error('ERROR:', e.message); try { await mongoose.disconnect(); } catch {} process.exit(1); });
