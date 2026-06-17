/**
 * One-off: set ManufacturingSettings.waxFilling.waxPerCartridgeUl to 19.2 µL
 * (correct dispense volume per cartridge — was wrong, e.g. 200). Requested by
 * Jacob 2026-06-11 after testing the WAX-FLOW-3 computed fill volume.
 *
 * Dry-run by default; pass --execute to write. Writes one audit_log row.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const EXECUTE = process.argv.includes('--execute');
const NEW_VALUE = 19.2;

async function main() {
	const URI = process.env.MONGODB_URI;
	if (!URI) throw new Error('MONGODB_URI not set');
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const doc = await db.collection('manufacturing_settings').findOne({ _id: 'default' as any });
	const current = (doc as any)?.waxFilling?.waxPerCartridgeUl;
	console.log(`Current waxFilling.waxPerCartridgeUl: ${current ?? '(unset)'}`);
	console.log(`Target: ${NEW_VALUE}`);

	if (!EXECUTE) {
		console.log('Dry run — pass --execute to write.');
	} else if (current === NEW_VALUE) {
		console.log('Already at target value — no write.');
	} else {
		await db.collection('manufacturing_settings').updateOne(
			{ _id: 'default' as any },
			{ $set: { 'waxFilling.waxPerCartridgeUl': NEW_VALUE, updatedAt: new Date() } },
			{ upsert: true }
		);
		await db.collection('audit_log').insertOne({
			_id: generateId() as any,
			tableName: 'manufacturing_settings',
			recordId: 'default',
			action: 'UPDATE',
			changedBy: 'system-manual',
			changedAt: new Date(),
			oldData: { 'waxFilling.waxPerCartridgeUl': current ?? null },
			newData: { 'waxFilling.waxPerCartridgeUl': NEW_VALUE },
			reason: 'Correct wax dispense volume per cartridge to 19.2 µL (Jacob, 2026-06-11)'
		});
		console.log('Updated + audit logged.');
	}

	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
