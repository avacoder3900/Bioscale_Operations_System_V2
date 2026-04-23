/**
 * Mark wax-filling run TF44Oxqs2RqL6KDI_yXBG as voided with a note
 * indicating it was a system-testing run. Related to the 11 cartridges
 * hard-deleted earlier today (2026-04-23) from FRIDGE-001.
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

const RUN_ID = 'TF44Oxqs2RqL6KDI_yXBG';
const NOTE = 'System Testing Cartridges, not apart of Active Manufacturing Line';

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const before = await db.collection('wax_filling_runs').findOne({ _id: RUN_ID });
	if (!before) throw new Error(`wax_filling_run ${RUN_ID} not found`);
	console.log(`Before: status=${(before as any).status}  abortReason=${(before as any).abortReason ?? '(none)'}`);

	const now = new Date();

	await db.collection('wax_filling_runs').updateOne(
		{ _id: RUN_ID },
		{
			$set: {
				status: 'voided',
				abortReason: NOTE,
				voidedAt: now,
				voidReason: NOTE,
				updatedAt: now
			}
		}
	);

	await db.collection('audit_logs').insertOne({
		_id: nanoid(21),
		tableName: 'wax_filling_runs',
		recordId: RUN_ID,
		action: 'UPDATE',
		oldData: {
			status: (before as any).status,
			abortReason: (before as any).abortReason ?? null
		},
		newData: {
			status: 'voided',
			abortReason: NOTE,
			voidedAt: now,
			voidReason: NOTE
		},
		changedAt: now,
		changedBy: 'jacob',
		reason: `Void wax-filling run — ${NOTE}. Related to 11 cartridges deleted from FRIDGE-001 on 2026-04-23.`
	} as any);

	const after = await db.collection('wax_filling_runs').findOne({ _id: RUN_ID });
	console.log(`After:  status=${(after as any).status}  abortReason=${(after as any).abortReason}  voidedAt=${(after as any).voidedAt?.toISOString?.()}`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
