export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, Equipment, TemperatureReading, generateId, AuditLog } from '$lib/server/db';
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
	// Use find + sort + manual grouping instead of aggregate (more reliable on serverless cold starts)
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

	// Optionally enrich with live Mocreo metadata (signal/battery)
	// This uses try/catch so it degrades gracefully on Vercel (no filesystem)
	const mocreoMeta = new Map<string, any>();
	try {
		const { fetchAllSensors } = await import('$lib/server/services/mocreo');
		const apiSensors = await fetchAllSensors();
		for (const s of apiSensors) {
			mocreoMeta.set(s.thingName, s);
		}
	} catch {
		// Mocreo API unavailable (e.g. Vercel) — use DB data only
	}

	// Build sensor list — DB readings are the primary source
	const knownSensorIds = new Set<string>();
	const sensors = latestReadings.map((r: any) => {
		knownSensorIds.add(r._id);
		const meta = mocreoMeta.get(r._id);
		const mapping = sensorToEquipment.get(r._id);
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
			temperatureMaxC: mapping?.temperatureMaxC ?? null
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
			temperatureMaxC: mapping?.temperatureMaxC ?? null
		});
	}

	// Detail view: load history for selected sensor
	let historyData: any[] = [];
	let selectedSensor: any = null;
	if (selectedSensorId) {
		selectedSensor = sensors.find(s => s.sensorId === selectedSensorId) ?? null;

		const now = new Date();
		let startTime: Date;
		if (range === 'year') {
			startTime = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
		} else if (range === 'month') {
			startTime = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
		} else {
			startTime = new Date(now.getTime() - 24 * 60 * 60 * 1000);
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
		range
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

		// Clear previous mapping if another equipment had this sensor
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
	}
};
