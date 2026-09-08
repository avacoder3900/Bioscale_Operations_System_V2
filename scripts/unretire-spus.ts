/**
 * ONE-OFF DATA CORRECTION - un-retire three SPUs retired in error.
 *
 * `retired` is terminal in LEGAL_TRANSITIONS (spu-status.ts), so the UI's
 * transitionStatus action cannot make this change. This script deliberately
 * bypasses that guard for exactly three documents, and writes the SAME
 * statusTransitions entry and AuditLog row that transitionStatus would, so the
 * change stays traceable in the DHR and the audit trail.
 *
 * The transition rules themselves are left untouched: retirement stays terminal
 * for every other unit.
 *
 * Dry run:  npx tsx scripts/unretire-spus.ts
 * Apply:    npx tsx scripts/unretire-spus.ts --apply
 */
import 'dotenv/config';
import { connectDB, Spu, User, AuditLog, generateId } from '../src/lib/server/db/index.js';

const UDIS = ['BT-M01-0000-0245', 'BT-M01-0000-0248', 'BT-M01-0000-0250'];
const TARGET = 'validating';
const REASON = 'Retired in error - returned to validating (one-off data correction)';
const OPERATOR_EMAIL = 'alejandrov@fannininnovation.com';

const apply = process.argv.includes('--apply');

async function main() {
	await connectDB();

	const user = (await User.findOne({ email: OPERATOR_EMAIL }, { username: 1 }).lean()) as any;
	if (!user) throw new Error(`No user found for ${OPERATOR_EMAIL} - refusing to write an unattributed change`);
	const actor = { _id: user._id as string, username: user.username as string };
	console.log(`actor: ${actor.username} (${actor._id})`);
	console.log(apply ? 'MODE: APPLY\n' : 'MODE: DRY RUN (pass --apply to write)\n');

	for (const udi of UDIS) {
		const spu = (await Spu.findOne({ udi }).lean()) as any;
		if (!spu) { console.log(`${udi}  SKIP - not found`); continue; }
		if (spu.finalizedAt) { console.log(`${udi}  SKIP - finalized`); continue; }
		if (spu.status !== 'retired') { console.log(`${udi}  SKIP - status is "${spu.status}", not retired`); continue; }

		console.log(`${udi}  ${spu._id}  retired -> ${TARGET}`);
		if (!apply) continue;

		const transition = {
			_id: generateId(),
			from: 'retired',
			to: TARGET,
			changedBy: actor,
			changedAt: new Date(),
			reason: REASON
		};
		await Spu.updateOne(
			{ _id: spu._id, status: 'retired' },
			{ $set: { status: TARGET }, $push: { statusTransitions: transition } }
		);
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spu._id,
			action: 'UPDATE',
			oldData: { status: 'retired' },
			newData: { status: TARGET, reason: REASON },
			changedBy: actor.username
		});
		const after = (await Spu.findById(spu._id, { status: 1 }).lean()) as any;
		console.log(`   -> now "${after.status}"`);
	}

	process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
