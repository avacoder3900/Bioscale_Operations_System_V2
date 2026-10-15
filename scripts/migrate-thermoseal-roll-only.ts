/**
 * Thermoseal overhaul (BUCKET-SYSTEM_PLAN §3.4, 2026-09-25): thermoseal is ONE
 * part, counted ONLY in rolls, moved ONLY by the bucket board's roll pull.
 *
 * The code side of that is in thermoseal-service.ts (THERMOSEAL_PART =
 * PT-CT-101) and the cut-thermoseal / WI-02 / laser-cutting pages, which no
 * longer write inventory. This script lines the data up with it:
 *
 *   part_definitions PT-CT-101   name → "Thermoseal Roll", unitOfMeasure → "roll"
 *                                (the count itself is NOT touched — the physical
 *                                count of 1 roll was recorded separately on 2026-09-25)
 *   part_definitions PT-CT-111   isActive → false  (Thermoseal Cut Sheet — stale)
 *   part_definitions PT-CT-112   isActive → false  (Thermoseal Laser Cut sheet — stale;
 *                                the −228 count is left as-is, it is no longer read)
 *   thermoseal_rolls             partNumber 'PT-CT-112' → 'PT-CT-101' (informational field)
 *   receiving_lots (PT-CT-112)   left alone — the board only looks at THERMOSEAL_PART lots now
 *   kanban_tasks                 an open thermoseal-restock card for the PT-CT-112 part id is
 *                                reported (not closed) — close it by hand if one exists
 *
 * Ledger rows (inventory_transactions) are immutable and are not rewritten.
 * One AuditLog summary row is written on --apply.
 *
 * Usage:
 *   npx tsx scripts/migrate-thermoseal-roll-only.ts --plan
 *   npx tsx scripts/migrate-thermoseal-roll-only.ts --apply
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const ROLL_PART = 'PT-CT-101';
const RETIRED_PARTS = ['PT-CT-111', 'PT-CT-112'];

const MODE: 'plan' | 'apply' | null = (() => {
	if (process.argv.includes('--apply')) return 'apply';
	if (process.argv.includes('--plan')) return 'plan';
	return null;
})();
if (!MODE) { console.error('Usage: --plan or --apply'); process.exit(1); }

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const parts = db.collection('part_definitions');
	const rolls = db.collection('thermoseal_rolls');
	const kanban = db.collection('kanban_tasks');
	const lots = db.collection('receiving_lots');

	const rollPart = await parts.findOne({ partNumber: ROLL_PART });
	if (!rollPart) { console.error(`${ROLL_PART} not found in part_definitions — nothing to do.`); process.exit(1); }
	console.log(`${ROLL_PART}: "${rollPart.name}" uom=${rollPart.unitOfMeasure ?? '—'} count=${rollPart.inventoryCount} isActive=${rollPart.isActive}`);
	console.log(`  → name "Thermoseal Roll", unitOfMeasure "roll" (count untouched: ${rollPart.inventoryCount} — record a physical count in rolls)`);

	for (const pn of RETIRED_PARTS) {
		const p = await parts.findOne({ partNumber: pn });
		if (!p) { console.log(`${pn}: not found (skip)`); continue; }
		console.log(`${pn}: "${p.name}" count=${p.inventoryCount} isActive=${p.isActive} → isActive false (count left as-is, no longer read)`);
		const open = await kanban.findOne({ sourceRef: `thermoseal-restock:${p._id}`, status: { $ne: 'done' }, archived: false });
		if (open) console.log(`  ! open thermoseal-restock kanban card for ${pn}: ${open._id} "${open.title}" — close it by hand`);
		const lotCount = await lots.countDocuments({ 'part.partNumber': pn });
		if (lotCount) console.log(`  ${lotCount} receiving lot(s) on ${pn} stay as history; the board reads ${ROLL_PART} lots only`);
	}

	const rollDocs = await rolls.countDocuments({ partNumber: { $ne: ROLL_PART } });
	console.log(`thermoseal_rolls with partNumber ≠ ${ROLL_PART}: ${rollDocs} → set to ${ROLL_PART}`);
	const rollLots = await lots.countDocuments({ 'part.partNumber': ROLL_PART, status: { $nin: ['rejected', 'returned'] } });
	console.log(`receiving lots on ${ROLL_PART} the board can pull from: ${rollLots}`);

	if (MODE === 'plan') {
		console.log('\n--plan: nothing written.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	const r1 = await parts.updateOne({ partNumber: ROLL_PART }, { $set: { name: 'Thermoseal Roll', unitOfMeasure: 'roll', updatedAt: now } });
	const r2 = await parts.updateMany({ partNumber: { $in: RETIRED_PARTS } }, { $set: { isActive: false, updatedAt: now } });
	const r3 = await rolls.updateMany({ partNumber: { $ne: ROLL_PART } }, { $set: { partNumber: ROLL_PART } });
	await db.collection('audit_log').insertOne({
		_id: generateId(),
		tableName: 'part_definitions',
		recordId: String(rollPart._id),
		action: 'THERMOSEAL_ROLL_ONLY_MIGRATION',
		changedBy: 'scripts/migrate-thermoseal-roll-only.ts',
		changedAt: now,
		newData: {
			rollPart: ROLL_PART, renamed: r1.modifiedCount,
			retiredParts: RETIRED_PARTS, retired: r2.modifiedCount,
			thermosealRollsRelabelled: r3.modifiedCount
		},
		reason: 'BUCKET-SYSTEM_PLAN §3.4 (2026-09-25): thermoseal is one roll-counted part moved only by the bucket board'
	} as any);
	console.log(`\n--apply: ${ROLL_PART} renamed (${r1.modifiedCount}), ${r2.modifiedCount} part(s) retired, ${r3.modifiedCount} roll doc(s) relabelled.`);
	console.log('Check that PT-CT-101 inventoryCount is the physical roll count (1 roll on 2026-09-25); if not, record a physical count.');
	await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
