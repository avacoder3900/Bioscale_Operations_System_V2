/**
 * One-shot: hard-delete the 11 wax-stored cartridges in FRIDGE-001.
 * User-directed on 2026-04-23. Writes AuditLog DELETE entries with full
 * document snapshots in `oldData` before removing. Bypasses sacred
 * middleware via the raw MongoDB driver.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

const IDS = [
	'4eeaa1c2-51e1-4bb9-a365-ec3bc1792861',
	'f81483a1-9250-4c79-bb13-4f8b662bd683',
	'7d62356c-7dae-43f6-8167-4c3c4ad908ed',
	'9b4d325f-4599-44ba-9bc5-31135c804f7b',
	'2752e88e-23cf-4596-a295-aba31b0824f5',
	'983be2c8-6c72-494a-97b2-e5bb8a0f9ee1',
	'fd6140ca-57b0-4a58-93f4-814b167533d9',
	'79ab3eee-67df-4179-b493-0e0b234c1120',
	'ba31cef3-b5de-4657-80fc-75280a400f73',
	'1bbc8933-edb5-4976-a127-5844cb915e6b',
	'6271346a-c16e-40c9-8262-7d252d6676bf'
];

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	// Re-fetch and verify the guardrails: still 11, all in FRIDGE-001, all wax_stored, none shipped/finalized
	const docs = await db.collection('cartridge_records').find({ _id: { $in: IDS } }).toArray();
	if (docs.length !== 11) {
		throw new Error(`Safety check: expected 11 cartridge_records, found ${docs.length}`);
	}
	for (const d of docs as any[]) {
		if (d.waxStorage?.location !== 'FRIDGE-001') {
			throw new Error(`Safety check: ${d._id} waxStorage.location="${d.waxStorage?.location}" != FRIDGE-001`);
		}
		if (d.status !== 'wax_stored') {
			throw new Error(`Safety check: ${d._id} status="${d.status}" != wax_stored`);
		}
		if (d.finalizedAt) {
			throw new Error(`Safety check: ${d._id} finalizedAt set — cannot delete a finalized doc`);
		}
		if (d.shipping?.shippedAt) {
			throw new Error(`Safety check: ${d._id} already shipped — cannot delete`);
		}
	}

	const now = new Date();
	// Audit log DELETE entries first (full doc snapshots preserved)
	const auditDocs = (docs as any[]).map((d) => ({
		_id: nanoid(21),
		tableName: 'cartridge_records',
		recordId: d._id,
		action: 'DELETE',
		oldData: d,
		newData: null,
		changedAt: now,
		changedBy: 'jacob',
		reason: 'User-directed removal of 11 wax-stored cartridges from FRIDGE-001 on 2026-04-23 (hard delete from mongo)'
	}));
	const auditRes = await db.collection('audit_logs').insertMany(auditDocs as any);
	console.log(`AuditLog DELETE entries inserted: ${auditRes.insertedCount}`);

	// Now delete via raw driver (bypasses Mongoose sacred middleware)
	const delRes = await db.collection('cartridge_records').deleteMany({ _id: { $in: IDS } });
	console.log(`cartridge_records deleted: ${delRes.deletedCount}`);

	// Confirm empty
	const remaining = await db.collection('cartridge_records').countDocuments({ _id: { $in: IDS } });
	console.log(`Remaining by _id: ${remaining}`);

	const remainingFridge001 = await db.collection('cartridge_records').countDocuments({
		status: 'wax_stored',
		'waxStorage.location': 'FRIDGE-001'
	});
	console.log(`FRIDGE-001 wax_stored cartridges remaining: ${remainingFridge001}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
