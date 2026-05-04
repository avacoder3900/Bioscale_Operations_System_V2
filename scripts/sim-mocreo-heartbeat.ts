/**
 * Simulate the mocreo-heartbeat lifecycle end-to-end against a real DB.
 *
 * Fakes a small set of probes by inserting TemperatureReading rows under
 * sim sensor IDs, then exercises the heartbeat decision logic and verifies
 * the right side-effects fire (alert created/updated/resolved). Sends a
 * fake-email mock so we don't actually email anyone during the sim.
 *
 * Usage: npx tsx scripts/sim-mocreo-heartbeat.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

const SIM_TAG = `sim-hb-${Date.now()}`;
const SIM_PROBES = ['SIM-PROBE-A', 'SIM-PROBE-B', 'SIM-PROBE-C', 'SIM-PROBE-D'];

const SILENT_THRESHOLD_MS = 30 * 60 * 1000;
const REMINDER_INTERVAL_MS = 25 * 60 * 1000;
const GATEWAY_OUTAGE_FRACTION = 0.5;

function nanoid(): string {
	const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
	let id = '';
	for (let i = 0; i < 21; i++) id += a[Math.floor(Math.random() * a.length)];
	return id;
}

interface ProbeHealth { sensorId: string; sensorName: string | null; equipmentName: string | null; latestReadingAt: Date | null; silent: boolean; }

async function getProbeHealth(db: any, now: Date): Promise<ProbeHealth[]> {
	// Sim narrows to just our SIM_PROBES so it doesn't pick up real readings.
	const recent = await db.collection('temperature_readings').aggregate([
		{ $match: { sensorId: { $in: SIM_PROBES } } },
		{ $group: { _id: '$sensorId', latestReadingAt: { $max: '$timestamp' }, sensorName: { $last: '$sensorName' } } }
	]).toArray();
	const recentMap = new Map<string, any>(recent.map((r: any) => [r._id, r]));

	const probes: ProbeHealth[] = [];
	for (const sensorId of SIM_PROBES) {
		const r = recentMap.get(sensorId);
		const latestReadingAt: Date | null = r?.latestReadingAt ?? null;
		const silent = !latestReadingAt || (now.getTime() - latestReadingAt.getTime()) > SILENT_THRESHOLD_MS;
		probes.push({
			sensorId,
			sensorName: r?.sensorName ?? sensorId,
			equipmentName: null,
			latestReadingAt,
			silent
		});
	}
	return probes;
}

interface SentEmail { tag: string; subject: string; }
const sentEmails: SentEmail[] = [];

async function fakeNotifyOutage(payload: any) {
	const isReminder = (payload.reminderNumber ?? 1) > 1;
	const tag = isReminder ? 'gateway_outage_reminder' : 'gateway_outage';
	const subject = isReminder
		? `[BIMS] GATEWAY STILL DOWN (reminder #${(payload.reminderNumber ?? 2) - 1})`
		: `[BIMS] GATEWAY OUTAGE`;
	sentEmails.push({ tag, subject });
}
async function fakeNotifyRecovered(_payload: any) {
	sentEmails.push({ tag: 'gateway_recovered', subject: '[BIMS] Gateway recovered' });
}

async function runHeartbeat(db: any, now: Date, probesOverride?: ProbeHealth[]): Promise<{ action: string; reminderNumber?: number }> {
	const probes = probesOverride ?? await getProbeHealth(db, now);
	const silent = probes.filter(p => p.silent);
	const haveSignal = probes.length > 0;
	const isOutage = haveSignal && silent.length / probes.length >= GATEWAY_OUTAGE_FRACTION;
	const isRecovered = haveSignal && !isOutage;

	const existingAlert = await db.collection('temperature_alerts').findOne({
		alertType: 'gateway_outage',
		acknowledged: false,
		resolvedAt: { $exists: false },
		// scope to sim
		sensorId: SIM_TAG
	}, { sort: { timestamp: -1 } });

	if (isRecovered && existingAlert) {
		await db.collection('temperature_alerts').updateOne({ _id: existingAlert._id }, {
			$set: {
				acknowledged: true, acknowledgedAt: now,
				resolvedAt: now, resolvedReason: 'auto-resolved: gateway recovered (heartbeat)'
			}
		});
		await fakeNotifyRecovered({
			recoveredAt: now, firstSeenAt: existingAlert.timestamp,
			totalReminders: Math.max(0, (existingAlert.notificationCount ?? 1) - 1),
			totalSensors: probes.length
		});
		return { action: 'recovered' };
	}

	if (existingAlert && !isRecovered) {
		const last = existingAlert.lastNotifiedAt
			? new Date(existingAlert.lastNotifiedAt).getTime()
			: new Date(existingAlert.timestamp).getTime();
		const sinceLast = now.getTime() - last;
		if (sinceLast < REMINDER_INTERVAL_MS) return { action: 'reminder_throttled' };

		const nextCount = (existingAlert.notificationCount ?? 1) + 1;
		await db.collection('temperature_alerts').updateOne({ _id: existingAlert._id }, {
			$set: { lastNotifiedAt: now, notificationCount: nextCount }
		});
		await fakeNotifyOutage({
			timestamp: now, totalSensors: probes.length, silentSensors: silent,
			firstSeenAt: existingAlert.timestamp, reminderNumber: nextCount
		});
		return { action: 'reminder_sent', reminderNumber: nextCount - 1 };
	}

	if (isOutage && !existingAlert) {
		await db.collection('temperature_alerts').insertOne({
			_id: nanoid(),
			sensorId: SIM_TAG, // tag for cleanup
			sensorName: 'Mocreo Gateway',
			alertType: 'gateway_outage',
			gatewayEvent: true,
			affectedSensorIds: silent.map(p => p.sensorId),
			lastNotifiedAt: now, notificationCount: 1,
			acknowledged: false,
			timestamp: now, createdAt: now
		});
		await fakeNotifyOutage({ timestamp: now, totalSensors: probes.length, silentSensors: silent });
		return { action: 'created' };
	}

	return { action: 'healthy' };
}

function pass(msg: string) { console.log(`  ✓ ${msg}`); }
function fail(msg: string): never { console.error(`  ✗ ${msg}`); process.exit(1); }

async function setReadings(db: any, ageMin: Record<string, number>, baseTime: Date) {
	await db.collection('temperature_readings').deleteMany({ sensorId: { $in: SIM_PROBES } });
	const docs = Object.entries(ageMin).map(([sensorId, mins]) => ({
		_id: nanoid(),
		sensorId, sensorName: sensorId,
		temperature: 4, humidity: 50,
		rawTemp: 400, rawHumidity: 5000,
		timestamp: new Date(baseTime.getTime() - mins * 60000)
	}));
	if (docs.length > 0) await db.collection('temperature_readings').insertMany(docs);
}

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	try {
		// === Test 1: All fresh, no existing alert → healthy ===
		console.log('Test 1: all probes fresh, no alert → healthy');
		const t0 = new Date();
		await setReadings(db, { 'SIM-PROBE-A': 5, 'SIM-PROBE-B': 5, 'SIM-PROBE-C': 5, 'SIM-PROBE-D': 5 }, t0);
		const r1 = await runHeartbeat(db, t0);
		if (r1.action !== 'healthy') fail(`expected healthy, got ${r1.action}`);
		pass(`action=healthy`);
		if (sentEmails.length !== 0) fail(`expected 0 emails, got ${sentEmails.length}`);
		pass('no emails sent');

		// === Test 2: Outage detected, no existing alert → create + email ===
		console.log('\nTest 2: 4/4 probes silent (60min stale), no alert → created');
		await setReadings(db, { 'SIM-PROBE-A': 60, 'SIM-PROBE-B': 60, 'SIM-PROBE-C': 60, 'SIM-PROBE-D': 60 }, t0);
		const r2 = await runHeartbeat(db, t0);
		if (r2.action !== 'created') fail(`expected created, got ${r2.action}`);
		pass(`action=created`);
		if (sentEmails.length !== 1) fail(`expected 1 email, got ${sentEmails.length}`);
		if (sentEmails[0].tag !== 'gateway_outage') fail(`expected gateway_outage, got ${sentEmails[0].tag}`);
		pass(`initial outage email sent (tag=${sentEmails[0].tag})`);

		const alert = await db.collection('temperature_alerts').findOne({ sensorId: SIM_TAG });
		if (!alert) fail('alert not in DB');
		if (alert.notificationCount !== 1) fail(`expected notificationCount=1, got ${alert.notificationCount}`);
		if (!alert.lastNotifiedAt) fail('lastNotifiedAt not set');
		pass(`alert created with notificationCount=1, lastNotifiedAt set`);

		// === Test 3: Outage continues, only 10min later → reminder throttled ===
		console.log('\nTest 3: outage continues, only 10min later → throttled');
		const t1 = new Date(t0.getTime() + 10 * 60 * 1000);
		const r3 = await runHeartbeat(db, t1);
		if (r3.action !== 'reminder_throttled') fail(`expected reminder_throttled, got ${r3.action}`);
		pass(`action=reminder_throttled`);
		if (sentEmails.length !== 1) fail(`expected still 1 email, got ${sentEmails.length}`);
		pass('no additional email sent within reminder interval');

		// === Test 4: 30min after creation → reminder sent ===
		console.log('\nTest 4: outage continues, 30min after last notify → reminder');
		const t2 = new Date(t0.getTime() + 30 * 60 * 1000);
		const r4 = await runHeartbeat(db, t2);
		if (r4.action !== 'reminder_sent') fail(`expected reminder_sent, got ${r4.action}`);
		if (r4.reminderNumber !== 1) fail(`expected reminderNumber=1, got ${r4.reminderNumber}`);
		pass(`action=reminder_sent, reminderNumber=1`);
		if (sentEmails.length !== 2) fail(`expected 2 emails, got ${sentEmails.length}`);
		if (sentEmails[1].tag !== 'gateway_outage_reminder') fail(`expected reminder tag, got ${sentEmails[1].tag}`);
		pass(`reminder email sent (tag=${sentEmails[1].tag})`);

		const alert4 = await db.collection('temperature_alerts').findOne({ sensorId: SIM_TAG });
		if (alert4.notificationCount !== 2) fail(`expected notificationCount=2, got ${alert4.notificationCount}`);
		pass('notificationCount bumped to 2');

		// === Test 5: another 30min → reminder #2 ===
		console.log('\nTest 5: another 30min → reminder #2');
		const t3 = new Date(t0.getTime() + 60 * 60 * 1000);
		const r5 = await runHeartbeat(db, t3);
		if (r5.action !== 'reminder_sent' || r5.reminderNumber !== 2) fail(`expected reminder #2, got ${JSON.stringify(r5)}`);
		pass('reminder #2 sent');
		if (sentEmails.length !== 3) fail(`expected 3 emails, got ${sentEmails.length}`);

		// === Test 6: gateway recovers (probes report fresh) → auto-resolve + recovery email ===
		console.log('\nTest 6: probes report fresh again → auto-resolve');
		const t4 = new Date(t0.getTime() + 90 * 60 * 1000);
		await setReadings(db, { 'SIM-PROBE-A': 2, 'SIM-PROBE-B': 2, 'SIM-PROBE-C': 2, 'SIM-PROBE-D': 2 }, t4);
		const r6 = await runHeartbeat(db, t4);
		if (r6.action !== 'recovered') fail(`expected recovered, got ${r6.action}`);
		pass('action=recovered');
		if (sentEmails.length !== 4) fail(`expected 4 emails, got ${sentEmails.length}`);
		if (sentEmails[3].tag !== 'gateway_recovered') fail(`expected gateway_recovered tag, got ${sentEmails[3].tag}`);
		pass(`recovery email sent (tag=${sentEmails[3].tag})`);

		const resolved = await db.collection('temperature_alerts').findOne({ sensorId: SIM_TAG });
		if (!resolved.acknowledged) fail('alert should be acknowledged after recovery');
		if (!resolved.resolvedAt) fail('resolvedAt should be set');
		pass(`alert acknowledged + resolvedAt set, reason="${resolved.resolvedReason}"`);

		// === Test 7: subsequent runs don't re-fire on resolved alert ===
		console.log('\nTest 7: another heartbeat after recovery → healthy, no email');
		const t5 = new Date(t0.getTime() + 120 * 60 * 1000);
		await setReadings(db, { 'SIM-PROBE-A': 3, 'SIM-PROBE-B': 3, 'SIM-PROBE-C': 3, 'SIM-PROBE-D': 3 }, t5);
		const r7 = await runHeartbeat(db, t5);
		if (r7.action !== 'healthy') fail(`expected healthy, got ${r7.action}`);
		pass('action=healthy');
		if (sentEmails.length !== 4) fail(`expected still 4 emails, got ${sentEmails.length}`);
		pass('no spurious post-recovery email');

		// === Test 8: outage threshold edge case (50% silent) ===
		console.log('\nTest 8: 2/4 probes silent (exactly 50%) → outage detected');
		await db.collection('temperature_alerts').deleteMany({ sensorId: SIM_TAG });
		sentEmails.length = 0;
		const t6 = new Date(t0.getTime() + 180 * 60 * 1000);
		await setReadings(db, { 'SIM-PROBE-A': 60, 'SIM-PROBE-B': 60, 'SIM-PROBE-C': 5, 'SIM-PROBE-D': 5 }, t6);
		const r8 = await runHeartbeat(db, t6);
		if (r8.action !== 'created') fail(`expected created at 50%, got ${r8.action}`);
		pass('50% silent threshold triggers outage');

		// === Test 9: REGRESSION — long outage, no probes in lookback window ===
		// Simulates a gateway down so long that no probes have reported in 7+
		// days. Heartbeat must (a) NOT auto-resolve (would falsely email
		// "recovered"), and (b) keep sending reminders so operators stay aware.
		console.log('\nTest 9: long outage, 0 probes in lookback + existing alert → reminder, NOT recovery');
		const emailsBefore = sentEmails.length;
		// Existing alert from Test 8 is still open.
		const t7 = new Date(t6.getTime() + 30 * 60 * 1000); // 30min after Test 8 created the alert
		const r9 = await runHeartbeat(db, t7, []); // empty probes set — long outage past lookback
		if (r9.action === 'recovered') fail(`empty probes set must NOT auto-resolve: got ${r9.action}`);
		if (sentEmails.some((e, i) => i >= emailsBefore && e.tag === 'gateway_recovered')) {
			fail(`spurious recovery email sent during empty-probes case`);
		}
		pass(`empty-probes case did not auto-resolve (action=${r9.action})`);
		if (r9.action !== 'reminder_sent') fail(`expected reminder during empty-probes outage, got ${r9.action}`);
		pass(`reminder still fires on empty-probes case (action=${r9.action})`);
		const stillOpen = await db.collection('temperature_alerts').findOne({ sensorId: SIM_TAG });
		if (stillOpen.acknowledged || stillOpen.resolvedAt) {
			fail(`alert was wrongly closed: acknowledged=${stillOpen.acknowledged}, resolvedAt=${stillOpen.resolvedAt}`);
		}
		pass('alert stays open through empty-probes window');

		// === Test 10: empty probes + NO existing alert → silent (no false alarm) ===
		console.log('\nTest 10: empty probes + no existing alert → healthy (no false alarm)');
		await db.collection('temperature_alerts').deleteMany({ sensorId: SIM_TAG });
		const emailsBefore10 = sentEmails.length;
		const r10 = await runHeartbeat(db, new Date(t7.getTime() + 60 * 1000), []);
		if (r10.action !== 'healthy') fail(`empty + no alert should be healthy, got ${r10.action}`);
		if (sentEmails.length !== emailsBefore10) fail(`unexpected email sent on empty/no-alert case`);
		pass('empty probes + no alert → no email, no action');

		console.log('\n--- Summary ---');
		console.log(`emails sent during sim: ${sentEmails.length}`);
		for (const e of sentEmails) console.log(`  - ${e.tag}: ${e.subject}`);
	} finally {
		console.log('\n--- Cleanup ---');
		const dr1 = await db.collection('temperature_readings').deleteMany({ sensorId: { $in: SIM_PROBES } });
		const dr2 = await db.collection('temperature_alerts').deleteMany({ sensorId: SIM_TAG });
		console.log(`deleted: ${dr1.deletedCount} TemperatureReadings, ${dr2.deletedCount} TemperatureAlerts`);
	}

	await mongoose.disconnect();
	console.log('\nALL TESTS PASSED ✓');
}

main().catch(err => { console.error(err); process.exit(1); });
