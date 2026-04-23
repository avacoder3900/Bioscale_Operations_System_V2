/**
 * Single AuditLog row documenting the 9,641-cartridge waxQc.status='Accepted'
 * backfill run earlier today. Operator was recorded as system-backfill; this
 * log captures rationale + scope + authorizing session for QMS traceability.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { nanoid } from 'nanoid';
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const now = new Date();

	// Verify scope
	const accepted = await db.collection('cartridge_records').countDocuments({
		'waxQc.status': 'Accepted',
		'waxQc.operator.username': 'system-backfill'
	});

	const entry = {
		_id: nanoid(),
		tableName: 'cartridge_records',
		recordId: 'BULK',
		action: 'BACKFILL',
		changedBy: 'jacobq@brevitest.com',
		changedAt: now,
		reason: `Retroactive write of waxQc.status='Accepted' on ${accepted} CartridgeRecords whose happy-path wax-QC step never wrote the field. Root cause: the pre-refactor completeQC action in wax-filling/+page.server.ts and opentron-control/wax/[runId]/+page.server.ts only wrote waxQc fields on the Reject path; acceptance was implicit (moving status from wax_filling → wax_filled). Discovered during 2026-04-22 audit when "Wax QC Yield" KPI showed 0% despite no rejections. Forward fix added in those files to write Accepted on the happy path. This backfill reconstructs the field for historical records that passed QC, so yield/inspection-coverage reports are consistent with reality. Affected records are limited to those with status IN [wax_filled, wax_stored, reagent_filled, inspected, sealed, cured, stored, released, shipped, linked, underway, completed, packeted, transferred, refrigerated, received] AND waxQc.recordedAt not already set. Rejected cartridges were untouched. Operator stamp on the backfilled records is {_id:'system', username:'system-backfill'}; the human reviewer who authorized the backfill is the changedBy on this audit row.`,
		newData: {
			scope: 'CartridgeRecord.waxQc.status',
			operation: 'set to "Accepted"',
			recordsAffected: accepted,
			script: 'scripts/backfill-wax-qc-and-backing.ts',
			authorizedBy: 'jacobq@brevitest.com',
			authorizedAt: now.toISOString()
		}
	};
	await db.collection('audit_logs').insertOne(entry);
	console.log(`AuditLog entry written: ${entry._id}`);
	console.log(`  scope=${accepted} cartridges`);

	await mongoose.disconnect();
})();
