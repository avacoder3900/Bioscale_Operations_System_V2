/**
 * One-shot: set manufacturing_settings.default.general.cartridgesPerLaserCutSheet = 16
 * (corrected from 6; historically drifted between 6/13 in code fallbacks).
 * Logs an AuditLog entry.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;
const NEW_VALUE = 16;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const col = db.collection('manufacturing_settings');
	const audit = db.collection('audit_logs');

	const before = await col.findOne({ _id: 'default' });
	const oldValue = (before as any)?.general?.cartridgesPerLaserCutSheet ?? null;
	console.log(`Before: cartridgesPerLaserCutSheet = ${oldValue}`);

	if (oldValue === NEW_VALUE) {
		console.log('Already at 16 — no change.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	await col.updateOne(
		{ _id: 'default' },
		{ $set: { 'general.cartridgesPerLaserCutSheet': NEW_VALUE, updatedAt: now } },
		{ upsert: true }
	);

	await audit.insertOne({
		_id: nanoid(21),
		tableName: 'manufacturing_settings',
		recordId: 'default',
		action: 'UPDATE',
		changedBy: 'jacob',
		changedAt: now,
		oldData: { 'general.cartridgesPerLaserCutSheet': oldValue },
		newData: { 'general.cartridgesPerLaserCutSheet': NEW_VALUE },
		reason: 'Correct cartridges per laser cut thermoseal sheet to 16 (was 6)'
	} as any);

	const after = await col.findOne({ _id: 'default' });
	console.log(`After:  cartridgesPerLaserCutSheet = ${(after as any)?.general?.cartridgesPerLaserCutSheet}`);

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
