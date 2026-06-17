/**
 * Simulate the per-sensor decision logic in mocreo-sync.ts to verify the
 * new idempotency + auto-resolve + hysteresis behavior. Replicates the
 * relevant branches inline (rather than calling runMocreoSync, which would
 * hit the real MOCREO API) and drives scenarios against the real DB.
 *
 * Usage: npx tsx scripts/sim-mocreo-sync.ts
 *
 * Companion to sim-mocreo-heartbeat.ts — together they cover the lifecycle:
 *   heartbeat sim → gateway-wide outage + reminders + auto-resolve
 *   sync sim     → per-sensor high/low/lost_connection + recovery
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const SIM_TAG = `sim-sync-${Date.now()}`;

const OFFLINE_THRESHOLD_MS = 30 * 60 * 1000;
const TEMP_RECOVERY_HYSTERESIS_C = 0.5;

function nanoid(): string {
	const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
	let id = '';
	for (let i = 0; i < 21; i++) id += a[Math.floor(Math.random() * a.length)];
	return id;
}

interface SentEmail { tag: string; sensorId: string; alertType: string; }
const sentEmails: SentEmail[] = [];

function fakeNotify(sensorId: string, alertType: string) {
	sentEmails.push({ tag: 'temperature_alert', sensorId, alertType });
}

interface ScenarioInput {
	sensorId: string;
	temperature: number | null;     // null = no fresh sample (gateway returned nothing)
	readingAgeMs: number;            // age of the latest reading in ms (only used when temperature != null)
	minC: number | null;
	maxC: number | null;
}

/**
 * Mirror the per-sensor branch in runMocreoSync (mocreo-sync.ts lines ~220-340)
 * after my edits. NOT a full reimplementation — only the high/low temp +
 * lost_connection + auto-resolve logic that's under test.
 *
 * Skips: gateway-event consolidation (covered by heartbeat sim), reading
 * persistence (orthogonal).
 */
async function simulateSensorTick(db: any, now: Date, s: ScenarioInput): Promise<string[]> {
	const created: string[] = [];
	const sensorId = `${SIM_TAG}:${s.sensorId}`;

	const stale = s.temperature == null || s.readingAgeMs > OFFLINE_THRESHOLD_MS;

	// --- High/low temp branch (only runs when we have a fresh reading) ---
	if (s.temperature != null && !stale) {
		const t = s.temperature;

		// LOW
		if (s.minC != null && t < s.minC) {
			const existing = await db.collection('temperature_alerts').findOne({
				sensorId, alertType: 'low_temp',
				acknowledged: false, resolvedAt: { $exists: false }
			});
			if (!existing) {
				await db.collection('temperature_alerts').insertOne({
					_id: nanoid(), sensorId, sensorName: s.sensorId,
					alertType: 'low_temp', threshold: s.minC, actualValue: t,
					acknowledged: false, timestamp: now, createdAt: now
				});
				fakeNotify(sensorId, 'low_temp');
				created.push('low_temp');
			}
		} else if (s.minC != null && t >= s.minC + TEMP_RECOVERY_HYSTERESIS_C) {
			await db.collection('temperature_alerts').updateOne(
				{ sensorId, alertType: 'low_temp', acknowledged: false, resolvedAt: { $exists: false } },
				{ $set: {
					acknowledged: true, acknowledgedAt: now,
					resolvedAt: now,
					resolvedReason: `auto-resolved: temperature recovered (${t.toFixed(1)}°C, threshold ${s.minC}°C)`
				} }
			);
		}

		// HIGH
		if (s.maxC != null && t > s.maxC) {
			const existing = await db.collection('temperature_alerts').findOne({
				sensorId, alertType: 'high_temp',
				acknowledged: false, resolvedAt: { $exists: false }
			});
			if (!existing) {
				await db.collection('temperature_alerts').insertOne({
					_id: nanoid(), sensorId, sensorName: s.sensorId,
					alertType: 'high_temp', threshold: s.maxC, actualValue: t,
					acknowledged: false, timestamp: now, createdAt: now
				});
				fakeNotify(sensorId, 'high_temp');
				created.push('high_temp');
			}
		} else if (s.maxC != null && t <= s.maxC - TEMP_RECOVERY_HYSTERESIS_C) {
			await db.collection('temperature_alerts').updateOne(
				{ sensorId, alertType: 'high_temp', acknowledged: false, resolvedAt: { $exists: false } },
				{ $set: {
					acknowledged: true, acknowledgedAt: now,
					resolvedAt: now,
					resolvedReason: `auto-resolved: temperature recovered (${t.toFixed(1)}°C, threshold ${s.maxC}°C)`
				} }
			);
		}
	}

	// --- lost_connection branch ---
	if (stale) {
		const existing = await db.collection('temperature_alerts').findOne({
			sensorId, alertType: 'lost_connection', acknowledged: false
		});
		if (!existing) {
			await db.collection('temperature_alerts').insertOne({
				_id: nanoid(), sensorId, sensorName: s.sensorId,
				alertType: 'lost_connection', threshold: null, actualValue: null,
				acknowledged: false, timestamp: now, createdAt: now
			});
			fakeNotify(sensorId, 'lost_connection');
			created.push('lost_connection');
		}
	} else {
		// Probe reporting fresh → auto-resolve any open lost_connection alert
		await db.collection('temperature_alerts').updateOne(
			{ sensorId, alertType: 'lost_connection', acknowledged: false, resolvedAt: { $exists: false } },
			{ $set: {
				acknowledged: true, acknowledgedAt: now,
				resolvedAt: now,
				resolvedReason: 'auto-resolved: probe reporting again'
			} }
		);
	}

	return created;
}

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { console.error(`  ✗ ${msg}`); process.exit(1); }

async function findOpenAlerts(db: any, sensorId: string, alertType: string) {
	return db.collection('temperature_alerts').find({
		sensorId: `${SIM_TAG}:${sensorId}`, alertType,
		acknowledged: false, resolvedAt: { $exists: false }
	}).toArray();
}
async function findAllAlerts(db: any, sensorId: string, alertType: string) {
	return db.collection('temperature_alerts').find({
		sensorId: `${SIM_TAG}:${sensorId}`, alertType
	}).toArray();
}

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	try {
		const now = new Date();

		// === Test 1: high_temp idempotency ===
		console.log('Test 1: high_temp — over-threshold twice → only 1 alert + 1 email');
		await simulateSensorTick(db, now, {
			sensorId: 'A', temperature: 9.0, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		await simulateSensorTick(db, new Date(now.getTime() + 5 * 60_000), {
			sensorId: 'A', temperature: 9.2, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		const openHigh = await findOpenAlerts(db, 'A', 'high_temp');
		if (openHigh.length !== 1) fail(`expected 1 open high_temp alert, got ${openHigh.length}`);
		pass('exactly 1 open high_temp alert');
		const highEmails = sentEmails.filter(e => e.sensorId.endsWith(':A') && e.alertType === 'high_temp');
		if (highEmails.length !== 1) fail(`expected 1 high_temp email, got ${highEmails.length}`);
		pass('exactly 1 high_temp email sent');

		// === Test 2: high_temp auto-resolve (past hysteresis) ===
		console.log('\nTest 2: high_temp — reading recovers to maxC - 1°C → resolved');
		await simulateSensorTick(db, new Date(now.getTime() + 10 * 60_000), {
			sensorId: 'A', temperature: 7.0, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		const stillOpenA = await findOpenAlerts(db, 'A', 'high_temp');
		if (stillOpenA.length !== 0) fail(`expected 0 open high_temp, got ${stillOpenA.length}`);
		pass('high_temp alert auto-resolved');
		const allA = await findAllAlerts(db, 'A', 'high_temp');
		if (!allA[0].resolvedAt) fail('resolvedAt not set');
		if (!allA[0].resolvedReason?.includes('recovered')) fail(`resolvedReason wrong: ${allA[0].resolvedReason}`);
		pass(`resolvedAt + resolvedReason set ("${allA[0].resolvedReason}")`);

		// === Test 3: hysteresis — recovery within band does NOT resolve ===
		console.log('\nTest 3: hysteresis — over-temp, then recovery to 7.7°C (within 0.5°C of maxC=8) → still open');
		sentEmails.length = 0;
		await simulateSensorTick(db, new Date(now.getTime() + 20 * 60_000), {
			sensorId: 'B', temperature: 9.0, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		await simulateSensorTick(db, new Date(now.getTime() + 25 * 60_000), {
			sensorId: 'B', temperature: 7.7, readingAgeMs: 60_000, minC: 2, maxC: 8  // 0.3°C below threshold — within hysteresis band
		});
		const stillOpenB = await findOpenAlerts(db, 'B', 'high_temp');
		if (stillOpenB.length !== 1) fail(`expected alert to remain open (within hysteresis), got ${stillOpenB.length}`);
		pass('hysteresis prevents premature resolution');

		// Then push it past 7.5°C exactly (=maxC - 0.5, the boundary) — should resolve
		await simulateSensorTick(db, new Date(now.getTime() + 30 * 60_000), {
			sensorId: 'B', temperature: 7.5, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		const resolvedB = await findOpenAlerts(db, 'B', 'high_temp');
		if (resolvedB.length !== 0) fail(`expected alert to resolve at maxC - 0.5°C boundary, got ${resolvedB.length}`);
		pass('boundary at maxC - hysteresis exactly resolves');

		// === Test 4: low_temp idempotency + auto-resolve ===
		console.log('\nTest 4: low_temp — under-threshold twice → 1 alert, then recovery → resolved');
		sentEmails.length = 0;
		await simulateSensorTick(db, new Date(now.getTime() + 40 * 60_000), {
			sensorId: 'C', temperature: -25, readingAgeMs: 60_000, minC: -20, maxC: -10
		});
		await simulateSensorTick(db, new Date(now.getTime() + 45 * 60_000), {
			sensorId: 'C', temperature: -24, readingAgeMs: 60_000, minC: -20, maxC: -10
		});
		const openLow = await findOpenAlerts(db, 'C', 'low_temp');
		if (openLow.length !== 1) fail(`expected 1 open low_temp, got ${openLow.length}`);
		pass('low_temp idempotent');
		const lowEmails = sentEmails.filter(e => e.alertType === 'low_temp');
		if (lowEmails.length !== 1) fail(`expected 1 low_temp email, got ${lowEmails.length}`);
		pass('exactly 1 low_temp email sent');

		await simulateSensorTick(db, new Date(now.getTime() + 50 * 60_000), {
			sensorId: 'C', temperature: -19, readingAgeMs: 60_000, minC: -20, maxC: -10  // minC + 1°C past hysteresis
		});
		const resolvedC = await findOpenAlerts(db, 'C', 'low_temp');
		if (resolvedC.length !== 0) fail(`expected low_temp resolved, got ${resolvedC.length}`);
		pass('low_temp auto-resolved');

		// === Test 5: lost_connection idempotency + auto-resolve ===
		console.log('\nTest 5: lost_connection — silent twice → 1 alert, then fresh reading → resolved');
		sentEmails.length = 0;
		// Reading > 30min stale
		await simulateSensorTick(db, new Date(now.getTime() + 60 * 60_000), {
			sensorId: 'D', temperature: 4, readingAgeMs: 45 * 60_000, minC: 2, maxC: 8
		});
		await simulateSensorTick(db, new Date(now.getTime() + 65 * 60_000), {
			sensorId: 'D', temperature: 4, readingAgeMs: 50 * 60_000, minC: 2, maxC: 8
		});
		const openLost = await findOpenAlerts(db, 'D', 'lost_connection');
		if (openLost.length !== 1) fail(`expected 1 open lost_connection, got ${openLost.length}`);
		pass('lost_connection idempotent');

		// Fresh reading arrives
		await simulateSensorTick(db, new Date(now.getTime() + 70 * 60_000), {
			sensorId: 'D', temperature: 4, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		const resolvedD = await findOpenAlerts(db, 'D', 'lost_connection');
		if (resolvedD.length !== 0) fail(`expected lost_connection resolved, got ${resolvedD.length}`);
		pass('lost_connection auto-resolved on fresh reading');

		// === Test 6: re-alert after auto-resolve ===
		console.log('\nTest 6: after auto-resolve, a fresh excursion creates a NEW alert');
		await simulateSensorTick(db, new Date(now.getTime() + 80 * 60_000), {
			sensorId: 'A', temperature: 9.5, readingAgeMs: 60_000, minC: 2, maxC: 8
		});
		const reopenA = await findOpenAlerts(db, 'A', 'high_temp');
		if (reopenA.length !== 1) fail(`expected a new high_temp alert after recovery, got ${reopenA.length}`);
		pass('resolved alerts do not block future re-alerting');
		const totalA = await findAllAlerts(db, 'A', 'high_temp');
		if (totalA.length !== 2) fail(`expected 2 total high_temp alerts for sensor A (one resolved, one open), got ${totalA.length}`);
		pass(`history preserved: ${totalA.length} alerts for sensor A (1 resolved + 1 open)`);

		// === Test 7: no thresholds → no high/low alerts ever ===
		console.log('\nTest 7: sensor with no thresholds → no alerts even on extreme readings');
		await simulateSensorTick(db, new Date(now.getTime() + 90 * 60_000), {
			sensorId: 'E', temperature: 50, readingAgeMs: 60_000, minC: null, maxC: null
		});
		const noOpenE = await findAllAlerts(db, 'E', 'high_temp');
		if (noOpenE.length !== 0) fail(`expected no alerts without thresholds, got ${noOpenE.length}`);
		pass('null thresholds → no alert fired');

		console.log('\n--- Summary ---');
		const sims = ['A', 'B', 'C', 'D', 'E'];
		for (const id of sims) {
			const all = await db.collection('temperature_alerts').find({ sensorId: `${SIM_TAG}:${id}` }).toArray();
			if (all.length > 0) console.log(`  sensor ${id}: ${all.length} alert(s) [${all.map((a: any) => `${a.alertType}${a.resolvedAt ? '→resolved' : '→open'}`).join(', ')}]`);
		}
	} finally {
		console.log('\n--- Cleanup ---');
		const dr = await db.collection('temperature_alerts').deleteMany({ sensorId: { $regex: `^${SIM_TAG}:` } });
		console.log(`deleted ${dr.deletedCount} simulated TemperatureAlerts`);
	}

	await mongoose.disconnect();
	console.log('\nALL TESTS PASSED ✓');
}

main().catch(err => { console.error(err); process.exit(1); });
