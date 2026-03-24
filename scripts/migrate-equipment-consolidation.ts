/**
 * Migration: Consolidate ALL equipment into the `equipment` collection.
 * 
 * - Copies robots from opentrons_robots → equipment (equipmentType: 'robot')
 * - Copies decks from consumables → equipment (equipmentType: 'deck')
 * - Copies cooling trays from consumables → equipment (equipmentType: 'cooling_tray')
 * 
 * Preserves existing _id values so references don't break.
 * Does NOT delete old collections.
 */

import mongoose from 'mongoose';
import * as dotenv from 'dotenv';

dotenv.config();

const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
	console.error('MONGODB_URI env var not set');
	process.exit(1);
}

async function migrate() {
	await mongoose.connect(MONGODB_URI!);
	const db = mongoose.connection.db!;

	const equipment = db.collection('equipment');
	const opentronsRobots = db.collection('opentrons_robots');
	const consumables = db.collection('consumables');

	// ── 1. Migrate robots ──────────────────────────────────────────────────────
	console.log('\n=== Migrating robots ===');
	const robots = await opentronsRobots.find({}).toArray();
	console.log(`Found ${robots.length} robots in opentrons_robots`);

	let robotsInserted = 0;
	let robotsSkipped = 0;

	for (const robot of robots) {
		const existing = await equipment.findOne({ _id: robot._id });
		if (existing) {
			console.log(`  SKIP: Robot ${robot._id} (${robot.name}) already in equipment`);
			robotsSkipped++;
			continue;
		}

		await equipment.insertOne({
			_id: robot._id,
			name: robot.name,
			equipmentType: 'robot',
			status: robot.isActive ? 'active' : 'offline',
			isActive: robot.isActive ?? true,
			ip: robot.ip,
			port: robot.port,
			robotSide: robot.robotSide,
			lastHealthOk: robot.lastHealthOk,
			lastHealthAt: robot.lastHealthAt,
			// preserve timestamps
			createdAt: robot.createdAt ?? new Date(),
			updatedAt: robot.updatedAt ?? new Date()
		});
		console.log(`  INSERTED: Robot ${robot._id} (${robot.name})`);
		robotsInserted++;
	}

	console.log(`Robots: ${robotsInserted} inserted, ${robotsSkipped} skipped`);

	// ── 2. Migrate decks ───────────────────────────────────────────────────────
	console.log('\n=== Migrating decks ===');
	const decks = await consumables.find({ type: 'deck' }).toArray();
	console.log(`Found ${decks.length} decks in consumables`);

	let decksInserted = 0;
	let decksSkipped = 0;

	for (const deck of decks) {
		const existing = await equipment.findOne({ _id: deck._id });
		if (existing) {
			console.log(`  SKIP: Deck ${deck._id} already in equipment`);
			decksSkipped++;
			continue;
		}

		await equipment.insertOne({
			_id: deck._id,
			name: deck._id, // decks are identified by ID (e.g., DECK-001)
			equipmentType: 'deck',
			status: deck.status ?? 'available',
			currentRobotId: deck.currentRobotId ?? null,
			lockoutUntil: deck.lockoutUntil ?? null,
			lastUsed: deck.lastUsed ?? null,
			usageLog: deck.usageLog ?? [],
			createdAt: deck.createdAt ?? new Date(),
			updatedAt: deck.updatedAt ?? new Date()
		});
		console.log(`  INSERTED: Deck ${deck._id}`);
		decksInserted++;
	}

	console.log(`Decks: ${decksInserted} inserted, ${decksSkipped} skipped`);

	// ── 3. Migrate cooling trays ───────────────────────────────────────────────
	console.log('\n=== Migrating cooling trays ===');
	const trays = await consumables.find({ type: 'cooling_tray' }).toArray();
	console.log(`Found ${trays.length} cooling trays in consumables`);

	let traysInserted = 0;
	let traysSkipped = 0;

	for (const tray of trays) {
		const existing = await equipment.findOne({ _id: tray._id });
		if (existing) {
			console.log(`  SKIP: Tray ${tray._id} already in equipment`);
			traysSkipped++;
			continue;
		}

		await equipment.insertOne({
			_id: tray._id,
			name: tray._id, // trays identified by ID (e.g., TRAY-001)
			equipmentType: 'cooling_tray',
			status: tray.status ?? 'available',
			assignedRunId: tray.assignedRunId ?? null,
			usageLog: tray.usageLog ?? [],
			createdAt: tray.createdAt ?? new Date(),
			updatedAt: tray.updatedAt ?? new Date()
		});
		console.log(`  INSERTED: Tray ${tray._id}`);
		traysInserted++;
	}

	console.log(`Trays: ${traysInserted} inserted, ${traysSkipped} skipped`);

	// ── Summary ────────────────────────────────────────────────────────────────
	console.log('\n=== Migration Complete ===');
	const totalEquipment = await equipment.countDocuments();
	console.log(`Total documents in equipment collection: ${totalEquipment}`);

	const breakdown = await equipment.aggregate([
		{ $group: { _id: '$equipmentType', count: { $sum: 1 } } }
	]).toArray();
	console.log('Breakdown by type:');
	for (const b of breakdown) {
		console.log(`  ${b._id}: ${b.count}`);
	}

	await mongoose.disconnect();
	console.log('\nDone!');
}

migrate().catch((err) => {
	console.error('Migration failed:', err);
	process.exit(1);
});
