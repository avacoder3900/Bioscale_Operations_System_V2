/**
 * Create a Kanban task for Nick to discuss the FRIDGE-002 ghost-cartridge
 * tracking failure with the team on Friday 2026-04-24.
 *
 * Idempotent: will not create a duplicate if a task with the same title
 * already exists for Nick.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const NICK = { _id: 'B_ZyirwCcytLTIJUkRrU_', username: 'nick' };
const PROJECT = { _id: '6ASDERVM0Zd_H9zU_k03g', name: 'QA Improvements', color: '#10B981' };
const TITLE = 'Team discussion: FRIDGE-002 ghost-cartridge tracking failure';
const DUE_DATE = new Date('2026-04-24T17:00:00Z'); // Friday 2026-04-24

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const tasks = db.collection('kanban_tasks');

	const existing = await tasks.findOne({ title: TITLE, 'assignee._id': NICK._id, archived: { $ne: true } });
	if (existing) {
		console.log(`Existing task found — skipping: _id=${existing._id}`);
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	const taskId = generateId();
	await tasks.insertOne({
		_id: taskId,
		title: TITLE,
		description: [
			'**Incident (2026-04-23):** Physical audit of FRIDGE-002 showed 59 cartridges; Mongo said 78 should be there. 20-cartridge gap = tracking failure.',
			'',
			'**Breakdown of the 20 ghosts:**',
			'- 10 cartridges from 2026-04-16 wax run `qnf7hfG3-k5ltHXXRdyP9` (Robot 1). All with no cooling tray assigned. 7 days old.',
			'- 8 cartridges from 2026-04-22 wax run `6o29m5Jre1aqGTXJ-fZdL` (Robot 2, TRAY-002). Attributed to "Zane Testing 4-21" per operator note.',
			'- 1 from run `4Z6AldZWCJ8EC_QG0pe2N` (TRAY-003) and 1 from run `h6-R5NfuP_yx5Lb4AO4i1` (TRAY-004) — both 2026-04-22.',
			'',
			'All 20 are now logged in `manual_cartridge_removals` as checkouts. Their CartridgeRecord.status stays `wax_stored` per the new checkout semantic — but they are physically gone and the fridge occupancy query still counts them until we patch the filter.',
			'',
			'**Discussion agenda for Friday 2026-04-24:**',
			'1. Root cause for the 10 April-16 no-tray cartridges — are they physically gone, or mis-located?',
			'2. Is "Zane Testing" a regular workflow that should have its own tracking path, not manual checkout backfills?',
			'3. Proposed controls: daily fridge reconciliation scan, mandatory cooling-tray assignment at wax storage, per-scan acknowledgement, automated alert when Mongo count drifts from last-known physical count.',
			'4. Follow-up: filter `manual_cartridge_removals` out of the active FRIDGE-002 occupancy query so dashboards show the real count.',
			'',
			'See also: `docs/scrap-tracking-and-manual-removal-handoff-2026-04-23.md`, `docs/tomorrow-catchup-2026-04-24.md`, `scripts/fix-checkout-20-ghosts.ts`.'
		].join('\n'),
		status: 'ready',
		prioritized: true,
		taskLength: 'short',
		sortOrder: 0,
		project: PROJECT,
		assignee: NICK,
		dueDate: DUE_DATE,
		tags: ['tracking', 'fridge-002', 'cartridge', 'incident-2026-04-23'],
		source: 'system-audit-2026-04-23',
		sourceRef: 'fix-checkout-20-ghosts.ts',
		statusChangedAt: now,
		readyDate: now,
		backlogDate: now,
		comments: [],
		transitions: [],
		activityLog: [{
			_id: generateId(),
			action: 'created',
			details: { reason: 'Automated audit flagged tracking failure' },
			createdAt: now,
			createdBy: 'system-audit-2026-04-23'
		}],
		proposals: [],
		archived: false,
		createdBy: 'system-audit-2026-04-23',
		createdAt: now,
		updatedAt: now
	});

	console.log(`Kanban task created: ${taskId}`);
	console.log(`  title: ${TITLE}`);
	console.log(`  project: ${PROJECT.name}`);
	console.log(`  assignee: ${NICK.username}`);
	console.log(`  dueDate: ${DUE_DATE.toISOString()}`);
	console.log(`  status: ready (prioritized)`);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
