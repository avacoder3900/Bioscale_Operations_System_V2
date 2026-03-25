export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, Equipment, TemperatureReading, TemperatureAlert, generateId, AuditLog } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	await connectDB();

	const selectedSensorId = url.searchParams.get('sensor');
	const range = url.searchParams.get('range') || 'day';

	// Get all equipment
	const equipment = await Equipment.find().sort({ equipmentType: 1, name: 1 }).lean();

	// Build sensor→equipment mapping
	const sensorToEquipment = new Map<string, {
		equipmentId: string;
		equipmentName: string;
		equipmentType: string;
		temperatureMinC: number | null;
		temperatureMaxC: number | null;
	}>();
	for (const e of equipment as any[]) {
		if (e.mocreoDeviceId) {
			sensorToEquipment.set(e.mocreoDeviceId, {
				equipmentId: String(e._id),
				equipmentName: e.name,
				equipmentType: e.equipmentType,
				temperatureMinC: e.temperatureMinC ?? null,
				temperatureMaxC: e.temperatureMaxC ?? null
			});
		}
	}

	// Get latest reading per sensor from DB (primary data source)
	const allReadings = await TemperatureReading.find({})
		.sort({ timestamp: -1 })
		.lean() as any[];

	const latestBySensor = new Map<string, any>();
	const countBySensor = new Map<string, number>();
	for (const r of allReadings) {
		const sid = r.sensorId;
		countBySensor.set(sid, (countBySensor.get(sid) ?? 0) + 1);
		if (!latestBySensor.has(sid)) {
			latestBySensor.set(sid, r);
		}
	}

	const latestReadings = [...latestBySensor.entries()].map(([sid, r]) => ({
		_id: sid,
		sensorName: r.sensorName,
		temperature: r.temperature,
		humidity: r.humidity,
		timestamp: r.timestamp,
		readingCount: countBySensor.get(sid) ?? 0
	}));

	// Query last 24h readings per sensor for summary stats + sparkline
	const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
	const last24hReadings = await TemperatureReading.find({
		timestamp: { $gte: twentyFourHoursAgo }
	}).sort({ timestamp: 1 }).select('sensorId temperature timestamp').lean() as any[];

	// Group 24h readings by sensor
	const stats24h = new Map<string, { min: number; max: number; sum: number; count: number; sparkline: number[] }>();
	for (const r of last24hReadings) {
		if (r.temperature == null) continue;
		const sid = r.sensorId;
		if (!stats24h.has(sid)) {
			stats24h.set(sid, { min: r.temperature, max: r.temperature, sum: r.temperature, count: 1, sparkline: [r.temperature] });
		} else {
			const s = stats24h.get(sid)!;
			s.min = Math.min(s.min, r.temperature);
			s.max = Math.max(s.max, r.temperature);
			s.sum += r.temperature;
			s.count++;
			s.sparkline.push(r.temperature);
		}
	}

	// Optionally enrich with live Mocreo metadata (signal/battery)
	const mocreoMeta = new Map<string, any>();
	try {
		const { fetchAllSensors } = await import('$lib/server/services/mocreo');
		const apiSensors = await fetchAllSensors();
		for (const s of apiSensors) {
			mocreoMeta.set(s.thingName, s);
		}
	} catch {
		// Mocreo API unavailable — use DB data only
	}

	// Build sensor list
	const knownSensorIds = new Set<string>();
	const now = new Date();
	const offlineThresholdMs = 30 * 60 * 1000; // 30 minutes

	const sensors = latestReadings.map((r: any) => {
		knownSensorIds.add(r._id);
		const meta = mocreoMeta.get(r._id);
		const mapping = sensorToEquipment.get(r._id);
		const s24 = stats24h.get(r._id);
		const lastReadAt = r.timestamp ? new Date(r.timestamp).getTime() : 0;
		const isOffline = !r.timestamp || (now.getTime() - lastReadAt > offlineThresholdMs);

		// Downsample sparkline to ~20 points
		let sparkline: number[] = [];
		if (s24) {
			const pts = s24.sparkline;
			if (pts.length <= 20) {
				sparkline = pts;
			} else {
				const step = pts.length / 20;
				for (let i = 0; i < 20; i++) {
					sparkline.push(pts[Math.floor(i * step)]);
				}
			}
		}

		return {
			sensorId: r._id,
			sensorName: meta?.name ?? r.sensorName ?? r._id,
			model: meta?.model ?? 'ST5',
			temperature: r.temperature ?? null,
			humidity: r.humidity ?? null,
			lastReadingAt: r.timestamp ?? null,
			readingCount: r.readingCount ?? 0,
			signalLevel: meta?.info?.signalLevel ?? null,
			batteryLevel: meta?.info?.batteryLevel ?? null,
			mappedEquipmentId: mapping?.equipmentId ?? null,
			mappedEquipmentName: mapping?.equipmentName ?? null,
			mappedEquipmentType: mapping?.equipmentType ?? null,
			temperatureMinC: mapping?.temperatureMinC ?? null,
			temperatureMaxC: mapping?.temperatureMaxC ?? null,
			isOffline,
			stats24h: s24 ? {
				min: Math.round(s24.min * 10) / 10,
				max: Math.round(s24.max * 10) / 10,
				avg: Math.round((s24.sum / s24.count) * 10) / 10,
				count: s24.count
			} : null,
			sparkline
		};
	});

	// Add sensors from Mocreo API that don't have DB readings yet
	for (const [thingName, meta] of mocreoMeta) {
		if (knownSensorIds.has(thingName)) continue;
		const mapping = sensorToEquipment.get(thingName);
		sensors.push({
			sensorId: thingName,
			sensorName: meta.name ?? thingName,
			model: meta.model ?? 'ST5',
			temperature: null,
			humidity: null,
			lastReadingAt: null,
			readingCount: 0,
			signalLevel: meta.info?.signalLevel ?? null,
			batteryLevel: meta.info?.batteryLevel ?? null,
			mappedEquipmentId: mapping?.equipmentId ?? null,
			mappedEquipmentName: mapping?.equipmentName ?? null,
			mappedEquipmentType: mapping?.equipmentType ?? null,
			temperatureMinC: mapping?.temperatureMinC ?? null,
			temperatureMaxC: mapping?.temperatureMaxC ?? null,
			isOffline: true,
			stats24h: null,
			sparkline: []
		});
	}

	// Fetch unacknowledged alerts
	const unacknowledgedAlerts = await TemperatureAlert.find({ acknowledged: false })
		.sort({ timestamp: -1 })
		.lean() as any[];

	// Detail view: load history for selected sensor
	let historyData: any[] = [];
	let selectedSensor: any = null;
	if (selectedSensorId) {
		selectedSensor = sensors.find(s => s.sensorId === selectedSensorId) ?? null;

		const nowMs = now.getTime();
		let startTime: Date;
		if (range === 'year') {
			startTime = new Date(nowMs - 365 * 24 * 60 * 60 * 1000);
		} else if (range === 'month') {
			startTime = new Date(nowMs - 30 * 24 * 60 * 60 * 1000);
		} else {
			startTime = new Date(nowMs - 24 * 60 * 60 * 1000);
		}

		historyData = await TemperatureReading.find({
			sensorId: selectedSensorId,
			timestamp: { $gte: startTime, $lte: now }
		})
			.sort({ timestamp: 1 })
			.select('temperature humidity timestamp')
			.lean();

		historyData = JSON.parse(JSON.stringify(historyData));
	}

	const totalReadings = await TemperatureReading.countDocuments();

	return {
		sensors: JSON.parse(JSON.stringify(sensors)),
		equipment: (equipment as any[]).map((e: any) => ({
			id: String(e._id),
			name: e.name,
			equipmentType: e.equipmentType,
			mocreoDeviceId: e.mocreoDeviceId ?? null
		})),
		totalReadings,
		isAdmin: isAdmin(locals.user),
		selectedSensorId,
		selectedSensor,
		historyData,
		range,
		alerts: JSON.parse(JSON.stringify(unacknowledgedAlerts))
	};
};

export const actions: Actions = {
	mapSensor: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const equipmentId = data.get('equipmentId')?.toString();
		const mocreoDeviceId = data.get('mocreoDeviceId')?.toString() || null;

		if (!equipmentId) return fail(400, { error: 'Equipment ID is required' });

		if (mocreoDeviceId) {
			await Equipment.updateMany(
				{ mocreoDeviceId, _id: { $ne: equipmentId } },
				{ $unset: { mocreoDeviceId: 1 } }
			);
		}

		await Equipment.findByIdAndUpdate(
			equipmentId,
			mocreoDeviceId
				? { mocreoDeviceId }
				: { $unset: { mocreoDeviceId: 1 } }
		);

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'equipment',
			recordId: equipmentId,
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: { mocreoDeviceId }
		});

		return { success: true };
	},

	pingSensor: async ({ request, locals }) => {
		await connectDB();
		const data = await request.formData();
		const sensorId = data.get('sensorId')?.toString();
		if (!sensorId) return fail(400, { error: 'Sensor ID is required' });

		try {
			const { fetchLatestReading, rawToC, rawToHumidity } = await import('$lib/server/services/mocreo');
			const sample = await fetchLatestReading(sensorId);
			if (!sample) return fail(404, { error: 'No reading available from sensor' });

			const temperature = sample.data.tm != null ? rawToC(sample.data.tm) : null;
			const humidity = sample.data.hm != null ? rawToHumidity(sample.data.hm) : null;
			const timestamp = new Date(sample.time * 1000);

			// Find equipment mapping
			const eq = await Equipment.findOne({ mocreoDeviceId: sensorId }).select('_id name').lean() as any;
			const equipmentId = eq ? String(eq._id) : null;

			// Store reading
			await TemperatureReading.create({
				_id: generateId(),
				sensorId,
				sensorName: sensorId,
				temperature,
				humidity,
				rawTemp: sample.data.tm ?? null,
				rawHumidity: sample.data.hm ?? null,
				timestamp,
				equipmentId
			});

			// Update equipment
			if (equipmentId && temperature != null) {
				await Equipment.findByIdAndUpdate(equipmentId, {
					currentTemperatureC: temperature,
					lastTemperatureReadAt: timestamp
				});
			}

			// Check thresholds and create alerts if needed
			if (eq && temperature != null) {
				const eqFull = await Equipment.findById(equipmentId).select('temperatureMinC temperatureMaxC name').lean() as any;
				if (eqFull?.temperatureMinC != null && temperature < eqFull.temperatureMinC) {
					await TemperatureAlert.create({
						_id: generateId(),
						sensorId,
						sensorName: sensorId,
						alertType: 'low_temp',
						threshold: eqFull.temperatureMinC,
						actualValue: temperature,
						equipmentId,
						equipmentName: eqFull.name,
						timestamp: new Date()
					});
				}
				if (eqFull?.temperatureMaxC != null && temperature > eqFull.temperatureMaxC) {
					await TemperatureAlert.create({
						_id: generateId(),
						sensorId,
						sensorName: sensorId,
						alertType: 'high_temp',
						threshold: eqFull.temperatureMaxC,
						actualValue: temperature,
						equipmentId,
						equipmentName: eqFull.name,
						timestamp: new Date()
					});
				}
			}

			return { success: true, pinged: true };
		} catch (err: any) {
			console.error('[PING] Error fetching sensor:', err);
			return fail(500, { error: 'Failed to ping sensor: ' + (err.message || 'Unknown error') });
		}
	},

	acknowledgeAlert: async ({ request, locals }) => {
		await connectDB();
		const data = await request.formData();
		const alertId = data.get('alertId')?.toString();
		if (!alertId) return fail(400, { error: 'Alert ID is required' });

		await TemperatureAlert.findByIdAndUpdate(alertId, {
			acknowledged: true,
			acknowledgedBy: { _id: locals.user?._id, username: locals.user?.username },
			acknowledgedAt: new Date()
		});

		return { success: true, dismissed: true };
	},

	setThresholds: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const equipmentId = data.get('equipmentId')?.toString();
		const minTemp = data.get('temperatureMinC')?.toString();
		const maxTemp = data.get('temperatureMaxC')?.toString();

		if (!equipmentId) return fail(400, { error: 'Equipment ID is required' });

		const update: any = {};
		if (minTemp !== undefined && minTemp !== '') update.temperatureMinC = parseFloat(minTemp);
		if (maxTemp !== undefined && maxTemp !== '') update.temperatureMaxC = parseFloat(maxTemp);

		await Equipment.findByIdAndUpdate(equipmentId, update);

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'equipment',
			recordId: equipmentId,
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: update
		});

		return { success: true };
	}
};
