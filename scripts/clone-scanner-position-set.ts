/**
 * Clone an OpentronsScannerPositionSet to one or more target robots,
 * optionally making each clone the default for its robot.
 *
 * Coordinates copy verbatim. Different OT-2s drift slightly in deck
 * calibration, so the clones are a *starting point* — they should be
 * jog-verified per robot before the auto-sweep is trusted in production.
 *
 *   npx tsx scripts/clone-scanner-position-set.ts <srcSetId> <targetRobotId,targetRobotId,...> [--default] [--apply]
 *
 * Without --apply, the script prints the plan and exits without writing.
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { customAlphabet } from 'nanoid';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const nanoid = customAlphabet(
	'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_',
	21
);

const srcSetId = process.argv[2];
const targetCsv = process.argv[3];
const makeDefault = process.argv.includes('--default');
const apply = process.argv.includes('--apply');

if (!srcSetId || !targetCsv) {
	console.error(
		'usage: npx tsx scripts/clone-scanner-position-set.ts <srcSetId> <targetRobotId,...> [--default] [--apply]'
	);
	process.exit(1);
}

const targetRobotIds = targetCsv.split(',').map((s) => s.trim()).filter(Boolean);

const uri = process.env.MONGODB_URI;
if (!uri) {
	console.error('MONGODB_URI not set');
	process.exit(1);
}

await mongoose.connect(uri);
const setsCol = mongoose.connection.collection('opentrons_scanner_position_sets');
const robotsCol = mongoose.connection.collection('opentrons_robots');

const src: any = await setsCol.findOne({ _id: srcSetId as any });
if (!src) {
	console.error(`source set not found: ${srcSetId}`);
	process.exit(2);
}

console.log(`\nsource set: "${src.title}"  robotId=${src.robotId}  positions=${(src.positions ?? []).length}/${src.positionCount}\n`);

const plan: Array<{
	targetRobotId: string;
	robotName: string;
	newSetId: string;
	demoteIds: string[];
}> = [];

for (const targetRobotId of targetRobotIds) {
	if (targetRobotId === src.robotId) {
		console.error(`skipping ${targetRobotId} — same as source robot, would create a duplicate.`);
		continue;
	}
	const robot: any = await robotsCol.findOne({ _id: targetRobotId as any });
	if (!robot) {
		console.error(`target robot not found: ${targetRobotId}`);
		continue;
	}
	// Collect existing default(s) on this robot that need demoting if we're
	// setting our new clone as default.
	const demoteIds: string[] = [];
	if (makeDefault) {
		const existingDefault = await setsCol.find({ robotId: targetRobotId, isDefault: true }).toArray();
		for (const s of existingDefault) demoteIds.push(s._id as any);
	}
	plan.push({
		targetRobotId,
		robotName: robot.name ?? targetRobotId,
		newSetId: nanoid(),
		demoteIds
	});
}

if (plan.length === 0) {
	console.error('no valid targets — aborting.');
	process.exit(3);
}

console.log('Plan:');
for (const p of plan) {
	console.log(`  → ${p.robotName} (${p.targetRobotId})`);
	console.log(`     new set _id=${p.newSetId}  title="${src.title}"  default=${makeDefault}`);
	if (p.demoteIds.length) {
		console.log(`     demote existing default set(s): ${p.demoteIds.join(', ')}`);
	}
}

if (!apply) {
	console.log('\n(dry-run — no DB changes. Re-run with --apply to commit.)');
	await mongoose.disconnect();
	process.exit(0);
}

const now = new Date();
for (const p of plan) {
	if (p.demoteIds.length) {
		await setsCol.updateMany(
			{ _id: { $in: p.demoteIds as any[] } },
			{ $set: { isDefault: false, updatedAt: now } }
		);
	}
	const doc = {
		_id: p.newSetId,
		robotId: p.targetRobotId,
		title: src.title,
		positionCount: src.positionCount,
		positions: src.positions ?? [],
		isDefault: makeDefault,
		pipetteMount: src.pipetteMount ?? 'left',
		pipetteName: src.pipetteName,
		notes:
			(src.notes ? src.notes + ' | ' : '') +
			`Cloned from set ${src._id} on ${now.toISOString().slice(0, 10)}. ` +
			'Coordinates verbatim — verify with a maintenance-run jog before relying on auto-sweep.',
		calibratedBy: src.calibratedBy ?? null,
		calibratedAt: src.calibratedAt ?? null,
		createdAt: now,
		updatedAt: now
	};
	await setsCol.insertOne(doc as any);
	console.log(`  ${p.robotName}: inserted ${p.newSetId}${p.demoteIds.length ? ` (demoted ${p.demoteIds.length})` : ''}`);
}

console.log(`\nDone. Cloned to ${plan.length} robot(s).`);
await mongoose.disconnect();
process.exit(0);
