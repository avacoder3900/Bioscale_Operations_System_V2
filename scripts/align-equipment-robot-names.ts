/**
 * Align Equipment.name with OpentronsRobot.name for robots that share the
 * same _id across both collections. Equipment.name is display-only — the
 * tie between the wax/reagent flows and the scanner sweep is the shared
 * _id, not the name — so renaming is safe.
 *
 *   npx tsx scripts/align-equipment-robot-names.ts          # dry-run
 *   npx tsx scripts/align-equipment-robot-names.ts --apply  # write
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const apply = process.argv.includes('--apply');

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set');
	process.exit(1);
}

await mongoose.connect(uri);
const opentrons = mongoose.connection.collection('opentrons_robots');
const equipment = mongoose.connection.collection('equipment');

const robots = await opentrons.find({}).toArray();

console.log('Plan:');
const plan: Array<{ id: string; from: string; to: string }> = [];

for (const r of robots) {
	const eq = await equipment.findOne({ _id: r._id as any, equipmentType: 'robot' });
	if (!eq) {
		console.log(`  skip ${r._id} "${r.name}" — no matching Equipment row.`);
		continue;
	}
	if (eq.name === r.name) {
		console.log(`  skip ${r._id} "${r.name}" — already aligned.`);
		continue;
	}
	console.log(`  ${r._id}: "${eq.name}" → "${r.name}"`);
	plan.push({ id: r._id as any, from: eq.name, to: r.name as string });
}

if (plan.length === 0) {
	console.log('\nNothing to do.');
	await mongoose.disconnect();
	process.exit(0);
}

if (!apply) {
	console.log('\n(dry-run — re-run with --apply to commit)');
	await mongoose.disconnect();
	process.exit(0);
}

for (const p of plan) {
	const res = await equipment.updateOne(
		{ _id: p.id as any },
		{ $set: { name: p.to, updatedAt: new Date() } }
	);
	console.log(`  ${p.id}: ${res.modifiedCount === 1 ? 'updated' : 'NO CHANGE'}`);
}

console.log(`\nDone. Aligned ${plan.length} robot name(s).`);
await mongoose.disconnect();
process.exit(0);
