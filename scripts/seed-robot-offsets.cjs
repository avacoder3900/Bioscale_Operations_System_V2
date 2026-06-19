/**
 * NATIVE-CALIBRATION-SYSTEM PRD 6 — seed the per-robot global deck offsets that
 * make the cutover live with zero positional change on the two zero-offset robots.
 *
 * R04 (reference) + B14 are 0,0,0 in BOTH wax & reagent ROBOT_OFFSETS, so seeding
 * 0,0,0 turns on BIMS-native mode (offset applied to ALL labware) as a no-op.
 * B07 is intentionally NOT seeded: its wax (0.15,-0.25,-1.3) and reagent
 * (0.2,-0.35,-0.35) offsets differ, so a single global value can't reproduce
 * both — it stays on its proven built-in table until captured on-site (PRD 5).
 *
 * Idempotent upsert by robotId. Run: node scripts/seed-robot-offsets.cjs
 */
const fs = require('fs');
const crypto = require('crypto');
const mongoose = require('mongoose');

function loadUri() {
	const env = fs.readFileSync(`${process.env.HOME}/Bioscale_Operations_System_V2/.env`, 'utf8');
	const line = env.split('\n').find((l) => l.startsWith('MONGODB_URI='));
	return line.slice('MONGODB_URI='.length).trim().replace(/^["']|["']$/g, '');
}

// Robot _ids resolved from opentrons_robots (R04/B14 — both zero-offset).
const SEED = [
	{ robotId: 'CCyX8FjTRGvYOd9vISGvi', name: 'Robot 2 R04', isReference: true },
	{ robotId: '8LufEAi5sYJ5JRk_fTfT7', name: 'Robot 1 B14', isReference: false }
];

(async () => {
	await mongoose.connect(loadUri(), { serverSelectionTimeoutMS: 60000 });
	const col = mongoose.connection.db.collection('robot_deck_offsets');

	// Exactly one reference across the table.
	if (SEED.some((s) => s.isReference)) {
		await col.updateMany({}, { $set: { isReference: false } });
	}

	for (const s of SEED) {
		await col.updateOne(
			{ robotId: s.robotId },
			{
				$set: {
					offset: { x: 0, y: 0, z: 0 },
					isReference: s.isReference,
					note: `Seeded by PRD 6 cutover — ${s.name} is 0,0,0 in both wax & reagent tables`,
					capturedBy: { _id: 'system', username: 'prd6-cutover' },
					capturedAt: new Date()
				},
				$setOnInsert: { _id: 'rdo-' + crypto.randomBytes(8).toString('hex') }
			},
			{ upsert: true }
		);
		console.log(`✓ ${s.name} (${s.robotId}) → 0,0,0${s.isReference ? ' [reference]' : ''}`);
	}

	const all = await col.find({}).toArray();
	console.log(`robot_deck_offsets now: ${all.map((a) => `${a.robotId}=${JSON.stringify(a.offset)}${a.isReference ? '*' : ''}`).join(', ')}`);
	await mongoose.disconnect();
})().catch((e) => { console.error(e.message); process.exit(1); });
