/**
 * Widen the fridge upper-limit temperature alert from 12C → 14C.
 *
 * Targets:
 *   - SensorConfig docs where temperatureMinC=0 AND temperatureMaxC=12
 *     (the Mocreo cold-fridge probes — 3 known sensors)
 *   - Equipment docs where equipmentType='fridge' AND temperatureMaxC=12
 *     (Fridge 3)
 *
 * Freezers (min=-30, max=-2), ultra-low (min=-45, max=-30), and room-temp
 * (min in 17/18, max in 30/32) sensors are NOT touched — they have
 * different thresholds for a reason.
 *
 * Run with --apply to execute. Without that flag, dry-run only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const NEW_MAX = 14;

async function main() {
	const apply = process.argv.includes('--apply');
	console.log(`MODE: ${apply ? 'APPLY' : 'DRY-RUN'}\n`);

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	console.log('=== Targets in sensor_configs (temperatureMinC=0, temperatureMaxC=12) ===');
	const sensorTargets = await db
		.collection('sensor_configs')
		.find({ temperatureMinC: 0, temperatureMaxC: 12 })
		.toArray();
	for (const s of sensorTargets as any[]) {
		console.log(`  ${s._id} (${s.thingName ?? '?'})  ${s.temperatureMinC} → ${s.temperatureMaxC} ⇒ ${s.temperatureMinC} → ${NEW_MAX}`);
	}
	console.log('');

	console.log("=== Targets in equipment (equipmentType='fridge', temperatureMaxC=12) ===");
	const eqTargets = await db
		.collection('equipment')
		.find({ equipmentType: 'fridge', temperatureMaxC: 12 })
		.toArray();
	for (const e of eqTargets as any[]) {
		console.log(`  ${e._id} ${e.name ?? e.barcode}  min=${e.temperatureMinC} max=${e.temperatureMaxC} ⇒ max=${NEW_MAX}`);
	}
	console.log('');

	if (!apply) {
		console.log('DRY-RUN complete. Re-run with --apply to execute.');
		await mongoose.disconnect();
		return;
	}

	const now = new Date();
	const operator = 'system-fridge-temp-widen';

	// 1. SensorConfigs
	const sc = await db
		.collection('sensor_configs')
		.updateMany(
			{ temperatureMinC: 0, temperatureMaxC: 12 },
			{ $set: { temperatureMaxC: NEW_MAX, updatedAt: now } }
		);
	console.log(`✓ SensorConfigs updated: ${sc.modifiedCount}`);

	// 2. Equipment
	const eq = await db
		.collection('equipment')
		.updateMany(
			{ equipmentType: 'fridge', temperatureMaxC: 12 },
			{ $set: { temperatureMaxC: NEW_MAX } }
		);
	console.log(`✓ Equipment updated: ${eq.modifiedCount}`);

	// 3. Audit log per touched record (use canonical 'audit_log' singular)
	const { nanoid } = await import('nanoid');
	for (const s of sensorTargets as any[]) {
		await db.collection('audit_log').insertOne({
			_id: nanoid(),
			tableName: 'sensor_configs',
			recordId: s._id,
			action: 'UPDATE',
			changedBy: operator,
			changedAt: now,
			oldData: { temperatureMaxC: 12 },
			newData: { temperatureMaxC: NEW_MAX },
			reason: 'Widen fridge upper-temp alert threshold per operator request 2026-04-27'
		});
	}
	for (const e of eqTargets as any[]) {
		await db.collection('audit_log').insertOne({
			_id: nanoid(),
			tableName: 'equipment',
			recordId: e._id,
			action: 'UPDATE',
			changedBy: operator,
			changedAt: now,
			oldData: { temperatureMaxC: 12 },
			newData: { temperatureMaxC: NEW_MAX },
			reason: 'Widen fridge upper-temp alert threshold per operator request 2026-04-27'
		});
	}
	console.log(`✓ Audit log entries written: ${sensorTargets.length + eqTargets.length}`);

	await mongoose.disconnect();
	console.log('\nDONE.');
}
main().catch(e => { console.error(e); process.exit(1); });
