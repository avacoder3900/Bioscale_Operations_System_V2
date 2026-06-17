/**
 * Populate slotIndex 8..23 of a scanner-position set by extrapolating from
 * the already-taught slotIndex 0..7 (column 0). Deck layout is 3 columns ×
 * 8 rows with snake numbering:
 *
 *   Col 0 (1-8 top→bot)   Col 1 (9-16 bot→top)   Col 2 (17-24 top→bot)
 *
 * Same-Y groupings:
 *   row r in col 0 = slotIndex r            (taught)
 *   row r in col 1 = slotIndex (15 - r)     (target, x = src + 148)
 *   row r in col 2 = slotIndex (16 + r)     (target, x = src + 296)
 *
 * Y and Z are copied from the source. Only X shifts by 148 mm per column.
 *
 *   npx tsx scripts/extrapolate-scanner-positions.ts <setId>            # dry-run
 *   npx tsx scripts/extrapolate-scanner-positions.ts <setId> --apply    # write
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const setId = process.argv[2];
const apply = process.argv.includes('--apply');
const COLUMN_STEP_MM = 148;

if (!setId) {
	console.error('usage: npx tsx scripts/extrapolate-scanner-positions.ts <setId> [--apply]');
	process.exit(1);
}

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set');
	process.exit(1);
}

await mongoose.connect(uri);
const col = mongoose.connection.collection('opentrons_scanner_position_sets');

const set: any = await col.findOne({ _id: setId as any });
if (!set) {
	console.error(`set not found: ${setId}`);
	process.exit(2);
}

console.log(`\nset: "${set.title}"  robotId=${set.robotId}  positionCount=${set.positionCount}`);

const bySlot = new Map<number, any>();
for (const p of set.positions ?? []) bySlot.set(p.slotIndex, p);

const taughtMissing: number[] = [];
for (let r = 0; r < 8; r++) {
	if (!bySlot.has(r)) taughtMissing.push(r);
}
if (taughtMissing.length) {
	console.error(
		`\nrefusing to extrapolate — source column (slotIndex 0..7) is incomplete. missing: ${taughtMissing.join(',')}`
	);
	process.exit(3);
}

const overwrites: number[] = [];
const newPositions: any[] = [];

for (let r = 0; r < 8; r++) {
	const src = bySlot.get(r);
	const col1Idx = 15 - r;
	const col2Idx = 16 + r;
	for (const [idx, dx] of [
		[col1Idx, COLUMN_STEP_MM],
		[col2Idx, 2 * COLUMN_STEP_MM]
	] as Array<[number, number]>) {
		if (bySlot.has(idx)) overwrites.push(idx);
		newPositions.push({
			slotIndex: idx,
			x: Number((src.x + dx).toFixed(3)),
			y: src.y,
			z: src.z
		});
	}
}

newPositions.sort((a, b) => a.slotIndex - b.slotIndex);

console.log('\nComputed positions (slotIndex → cartridge slot label):');
console.log(
	'  slot  slotIndex     x         y         z     (source slotIndex, dx)'
);
for (const p of newPositions) {
	const r = p.slotIndex >= 16 ? p.slotIndex - 16 : 15 - p.slotIndex;
	const dx = p.slotIndex >= 16 ? 2 * COLUMN_STEP_MM : COLUMN_STEP_MM;
	const cartSlot = p.slotIndex + 1;
	console.log(
		`  ${String(cartSlot).padStart(4)}  ${String(p.slotIndex).padStart(9)}  ${p.x
			.toFixed(2)
			.padStart(8)}  ${p.y.toFixed(2).padStart(8)}  ${p.z.toFixed(2).padStart(7)}    (src ${r}, +${dx})`
	);
}

if (overwrites.length) {
	console.log(
		`\nWARNING: ${overwrites.length} target slotIndex already had a stored position and will be overwritten: [${overwrites.join(', ')}]`
	);
}

if (!apply) {
	console.log('\n(dry-run — no DB changes)');
	console.log('to apply: re-run with --apply');
	await mongoose.disconnect();
	process.exit(0);
}

// Replace positions: keep slotIndex 0..7 from the existing set, add the new 8..23
const keep = (set.positions ?? []).filter((p: any) => p.slotIndex < 8);
const merged = [...keep, ...newPositions].sort((a, b) => a.slotIndex - b.slotIndex);

const res = await col.updateOne(
	{ _id: setId as any },
	{ $set: { positions: merged, updatedAt: new Date() } }
);
console.log(`\napplied. matched=${res.matchedCount} modified=${res.modifiedCount}`);
console.log(`set now has ${merged.length} positions (slotIndex 0..${merged.length - 1}).`);

await mongoose.disconnect();
process.exit(0);
