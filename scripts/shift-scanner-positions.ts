/**
 * Shift every taught position in a scanner-position set by a fixed
 * delta on X/Y/Z. Use when the operator wants to globally nudge a set
 * (e.g. lower Z by 50mm to fit the OT-2 motion envelope) without
 * having to re-jog all 24 slots.
 *
 *   npx tsx scripts/shift-scanner-positions.ts <setId> --dz=-50            # dry-run
 *   npx tsx scripts/shift-scanner-positions.ts <setId> --dz=-50 --apply
 *   npx tsx scripts/shift-scanner-positions.ts <setId> --dx=2 --dy=-1 --dz=-40 --apply
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const setId = args.find((a) => !a.startsWith('--'));
const apply = args.includes('--apply');
function parseFlag(name: string): number {
	const found = args.find((a) => a.startsWith(`--${name}=`));
	return found ? parseFloat(found.slice(`--${name}=`.length)) : 0;
}
const dx = parseFlag('dx');
const dy = parseFlag('dy');
const dz = parseFlag('dz');

if (!setId || (dx === 0 && dy === 0 && dz === 0)) {
	console.error(
		'usage: npx tsx scripts/shift-scanner-positions.ts <setId> [--dx=N] [--dy=N] [--dz=N] [--apply]'
	);
	console.error('  at least one of --dx / --dy / --dz must be non-zero');
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

const positions = (set.positions ?? []) as Array<any>;
if (positions.length === 0) {
	console.error('set has no positions to shift');
	process.exit(3);
}

console.log(`\nset: "${set.title}"  robotId=${set.robotId}  positions=${positions.length}`);
console.log(`shift: dx=${dx}  dy=${dy}  dz=${dz}\n`);

const shifted = positions.map((p) => ({
	...p,
	x: Number((p.x + dx).toFixed(3)),
	y: Number((p.y + dy).toFixed(3)),
	z: Number((p.z + dz).toFixed(3))
}));

console.log('  slot  before                             after');
for (let i = 0; i < positions.length; i++) {
	const a = positions[i];
	const b = shifted[i];
	console.log(
		`  ${String(a.slotIndex + 1).padStart(4)}  (${a.x.toFixed(2)}, ${a.y.toFixed(2)}, ${a.z.toFixed(2)})  →  (${b.x.toFixed(2)}, ${b.y.toFixed(2)}, ${b.z.toFixed(2)})`
	);
}

if (!apply) {
	console.log('\n(dry-run — no DB changes. Re-run with --apply to commit.)');
	await mongoose.disconnect();
	process.exit(0);
}

const res = await col.updateOne(
	{ _id: setId as any },
	{ $set: { positions: shifted, updatedAt: new Date() } }
);
console.log(`\napplied. matched=${res.matchedCount} modified=${res.modifiedCount}`);
await mongoose.disconnect();
process.exit(0);
