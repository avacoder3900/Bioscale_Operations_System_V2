/**
 * Set a robot's tip-calibration rejection cap, and refresh the stored wax
 * protocol source so the robot's copy actually accepts that cap.
 *
 * Both halves are needed and the ORDER matters. The protocol declares
 * max_tip_adjust with a ceiling; sending a value above it makes POST /runs fail
 * outright. So the .py carrying the raised ceiling has to reach the robot before
 * BIMS starts sending the larger number. Refreshing OpentronProtocol.fileContent
 * is what lets a Sync (or the run-start freshness gate re-upload) deliver it.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/set-tip-adjust-cap.ts --robot <id> --cap 8 [--apply]
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const argv = process.argv.slice(2);
const arg = (n: string) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const MODE: 'plan' | 'apply' = argv.includes('--apply') ? 'apply' : 'plan';
const robotId = arg('robot');
const cap = Number(arg('cap'));
const PY = 'protocols/Wax_Filling_GEN7_Cartridge.py';

if (!robotId || !Number.isFinite(cap) || cap <= 0) {
	console.error('Usage: --robot <robotId> --cap <mm> [--apply]');
	process.exit(1);
}

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] ${db.databaseName}\n`);

	// --- 1. the robot's cap -------------------------------------------------
	const fix = await db.collection('tip_calibrator_fixtures').findOne({ robotId });
	const robot = await db.collection('opentrons_robots').findOne({ _id: robotId as any });
	console.log(`robot            ${robot?.name ?? robotId}`);
	console.log(`fixture present  ${!!fix}`);
	console.log(`maxTipAdjust     ${fix?.maxTipAdjust ?? '(unset — protocol default 4.0)'} -> ${cap}`);
	if (!fix) { console.error('No tip_calibrator_fixtures row for that robot. Refusing.'); process.exit(1); }

	// --- 2. the stored protocol source -------------------------------------
	const local = fs.readFileSync(PY, 'utf8');
	const localHash = crypto.createHash('sha256').update(local).digest('hex');
	const proto = await db.collection('opentrons_protocols')
		.find({ processType: 'wax-filling', isActive: true }).sort({ createdAt: -1 }).limit(1).toArray();
	const p = proto[0] as any;
	if (!p) { console.error('No active wax-filling protocol row. Refusing.'); process.exit(1); }

	const storedHash = crypto.createHash('sha256').update(String(p.fileContent ?? '')).digest('hex');
	const ceilingLocal = /maximum\s*=\s*12\.0/.test(local);
	console.log(`\nstored protocol  ${p.fileName}`);
	console.log(`stored sha256    ${storedHash.slice(0, 16)}`);
	console.log(`local sha256     ${localHash.slice(0, 16)}  ${storedHash === localHash ? '(already current)' : '(will refresh)'}`);
	console.log(`local ceiling 12 ${ceilingLocal}`);
	if (!ceilingLocal) {
		console.error('\nLocal .py does not carry the raised ceiling (maximum=12.0). Refusing —\nsending a cap above the declared bound would make POST /runs fail.');
		process.exit(1);
	}

	if (MODE === 'plan') {
		console.log('\nRe-run with --apply to write. After applying, SYNC to the robot so the\nnew .py reaches it BEFORE the larger cap is sent.');
		await mongoose.disconnect();
		return;
	}

	await db.collection('tip_calibrator_fixtures').updateOne({ robotId }, { $set: { maxTipAdjust: cap } });
	if (storedHash !== localHash) {
		await db.collection('opentrons_protocols').updateOne(
			{ _id: p._id },
			{ $set: { fileContent: local, fileHash: localHash, updatedAt: new Date() } }
		);
		console.log('refreshed stored wax protocol source');
	}
	await db.collection('audit_log').insertOne({
		_id: 'atc-' + crypto.randomBytes(8).toString('hex'),
		tableName: 'tip_calibrator_fixtures',
		recordId: robotId,
		action: 'set_max_tip_adjust',
		oldData: { maxTipAdjust: fix.maxTipAdjust ?? null },
		newData: { maxTipAdjust: cap, protocolRefreshed: storedHash !== localHash },
		changedAt: new Date(),
		changedBy: 'system-set-tip-adjust-cap'
	} as any);

	console.log(`\nAPPLIED. ${robot?.name ?? robotId} cap = ${cap}mm.`);
	console.log('NEXT: Sync the wax protocol to this robot so it picks up the raised ceiling.');
	await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
