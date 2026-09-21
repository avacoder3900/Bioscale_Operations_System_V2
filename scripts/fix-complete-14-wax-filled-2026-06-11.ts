/**
 * One-off fix: set status='completed' on 14 specific cartridges currently
 * stuck at status='wax_filled'. Requested by jacobq 2026-06-11.
 *
 * Per cartridge the script writes:
 *   1. CartridgeRecord update: status='wax_filled' -> 'completed'
 *   2. AuditLog entry for the status change
 *
 * Idempotent: re-running skips any cartridge no longer status='wax_filled'.
 * Pass --dry-run to pre-check only (no writes).
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const DRY_RUN = process.argv.includes('--dry-run');
const OPERATOR = 'system-fix-2026-06-11';
const REASON = 'Manual status correction: wax_filled -> completed, requested by jacobq [fix-complete-14-wax-filled-2026-06-11]';

const IDS = [
	'79ea70b4-889e-4ce7-8ab3-957a35f6dad8',
	'1448a12e-7d5a-4434-b232-d0f032b1f783',
	'0ed5de51-48fe-423e-9bfb-24e5a1671dfb',
	'e195550a-4d3c-454a-baa8-795d1aee7ba0',
	'3d862335-14f7-46e2-b5ac-acc2c00677f1',
	'e7aab835-0bd5-43ab-9e9d-ba1edddfb722',
	'c243afc0-93b8-429a-a1ec-0001b9cf0528',
	'6e64e451-2488-48e2-8abe-5019cf84a5a1',
	'3c6d689b-bcb7-4c12-9dfd-b22f37004420',
	'f691df93-2d92-40d5-88e4-31844ff4c61d',
	'd6f88b1e-11fb-4de2-a8a9-7570f4f73a1a',
	'cd971fa3-b419-48e8-80e4-b50b4d332309',
	'ac6a51e5-15db-4901-9902-9719d912ea86',
	'20704f69-ec4e-468a-87aa-c679a5e85498'
];

async function main() {
	const URI = process.env.MONGODB_URI;
	if (!URI) throw new Error('MONGODB_URI not set');

	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const carts = db.collection('cartridge_records');
	const audits = db.collection('audit_log');

	const docs = await carts
		.find({ _id: { $in: IDS } as any })
		.project({ _id: 1, status: 1, finalizedAt: 1 })
		.toArray() as any[];
	const byId = new Map(docs.map((d) => [d._id, d]));

	const eligible: string[] = [];
	const alreadyCompleted: string[] = [];
	const wrongStatus: { id: string; status: string }[] = [];
	const finalized: string[] = [];
	const missing: string[] = [];

	for (const cid of IDS) {
		const d = byId.get(cid);
		if (!d) { missing.push(cid); continue; }
		if (d.finalizedAt) { finalized.push(cid); continue; }
		if (d.status === 'completed') { alreadyCompleted.push(cid); continue; }
		if (d.status !== 'wax_filled') { wrongStatus.push({ id: cid, status: d.status }); continue; }
		eligible.push(cid);
	}

	console.log(`Pre-check (${IDS.length} IDs):`);
	console.log(`  eligible (status=wax_filled): ${eligible.length}`);
	console.log(`  already completed (skip):     ${alreadyCompleted.length}`);
	console.log(`  finalized sacred (skip):      ${finalized.length}`);
	console.log(`  wrong status (skip):          ${wrongStatus.length}`);
	for (const w of wrongStatus) console.log(`    ${w.id}: status='${w.status}'`);
	console.log(`  not found:                    ${missing.length}`);
	for (const m of missing) console.log(`    ${m}`);

	if (DRY_RUN) {
		console.log('\nDry run — no writes. Exiting.');
		await mongoose.disconnect();
		return;
	}

	if (eligible.length === 0) {
		console.log('\nNothing to do. Exiting.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	console.log(`\nUpdating ${eligible.length} cartridges...`);
	let updated = 0, auditsWritten = 0;

	for (const cid of eligible) {
		const res = await carts.updateOne(
			{ _id: cid as any, status: 'wax_filled' }, // defense against concurrent status change
			{ $set: { status: 'completed', updatedAt: now } }
		);
		if (res.modifiedCount !== 1) {
			console.log(`  SKIPPED ${cid}: status changed concurrently`);
			continue;
		}
		updated++;

		await audits.insertOne({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: cid,
			action: 'UPDATE',
			changedBy: OPERATOR,
			changedAt: now,
			oldData: { status: 'wax_filled' },
			newData: { status: 'completed' },
			reason: REASON
		});
		auditsWritten++;
	}

	console.log(`\nDone.`);
	console.log(`  CartridgeRecord updates: ${updated}`);
	console.log(`  AuditLog entries:        ${auditsWritten}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
