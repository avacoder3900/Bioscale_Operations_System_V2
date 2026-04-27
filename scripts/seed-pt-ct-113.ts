/**
 * One-shot: seed PT-CT-113 "Top Seal Cut Sheet" into part_definitions.
 *
 * This is the intermediate part produced by the top-seal-cutting stage
 * (roll PT-CT-103 → 36 cut sheets PT-CT-113) and consumed at top-seal time
 * (1 sheet per batch of up to 12 cartridges).
 *
 * Mirrors the PT-CT-111 "Thermoseal Cut Sheet" pattern used by the
 * cut-thermoseal → laser-cut flow. Idempotent: safe to re-run.
 *
 * Run: npx tsx scripts/seed-pt-ct-113.ts
 */
import mongoose from 'mongoose';
import { nanoid } from 'nanoid';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;

const PART = {
	partNumber: 'PT-CT-113',
	name: 'Top Seal Cut Sheet',
	description: 'Top seal material cut to 17.75" sheets from an 18 yd roll (PT-CT-103). One sheet seals up to 12 cartridges.',
	category: 'cartridge-intermediate',
	unitOfMeasure: 'sheets',
	bomType: 'cartridge' as const,
	isActive: true,
	scanRequired: true,
	inventoryCount: 0
};

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const parts = db.collection('part_definitions');
	const audit = db.collection('audit_logs');

	const existing = await parts.findOne({ partNumber: PART.partNumber });
	if (existing) {
		console.log(`PT-CT-113 already exists (_id=${existing._id}, inventoryCount=${(existing as any).inventoryCount ?? 0}). No change.`);
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	const id = nanoid(21);
	await parts.insertOne({
		_id: id,
		...PART,
		createdAt: now,
		updatedAt: now
	} as any);

	await audit.insertOne({
		_id: nanoid(21),
		tableName: 'part_definitions',
		recordId: id,
		action: 'INSERT',
		changedBy: 'seed-script',
		changedAt: now,
		newData: PART,
		reason: 'Seed PT-CT-113 Top Seal Cut Sheet — intermediate produced by top-seal-cutting, consumed at top-seal batch'
	} as any);

	console.log(`✓ Seeded PT-CT-113 "${PART.name}" (_id=${id})`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
