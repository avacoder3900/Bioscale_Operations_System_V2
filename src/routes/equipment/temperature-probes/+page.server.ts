export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, Equipment, TemperatureReading, generateId, AuditLog } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import { fetchAllSensors } from '$lib/server/services/mocreo';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	try {
		await connectDB();

		// Get all equipment
		const equipment = await Equipment.find().sort({ equipmentType: 1, name: 1 }).lean();

		// Get all Mocreo sensors from the API
		let mocreoSensors: { thingName: string; name: string; model: string }[] = [];
		try {
			mocreoSensors = await fetchAllSensors();
		} catch (err) {
			console.error('[TEMP PROBES] Mocreo API error:', err instanceof Error ? err.message : err);
		}

		// Get ALL readings from DB (latest per sensor)
		const latestReadings = await TemperatureReading.aggregate([
			{ $sort: { timestamp: -1 } },
			{ $group: {
				_id: '$sensorId',
				sensorName: { $first: '$sensorName' },
				temperature: { $first: '$temperature' },
				humidity: { $first: '$humidity' },
				timestamp: { $first: '$timestamp' },
				readingCount: { $sum: 1 }
			}}
		]);

		// Build sensor→equipment mapping
		const sensorToEquipment = new Map<string, any>();
		for (const e of equipment as any[]) {
			if (e.mocreoDeviceId) {
				sensorToEquipment.set(e.mocreoDeviceId, {
					equipmentId: String(e._id),
					equipmentName: e.name,
					equipmentType: e.equipmentType
				});
			}
		}

		// Build reading map by sensorId
		const readingMap = new Map<string, any>();
		for (const r of latestReadings) {
			readingMap.set(r._id, r);
		}

		// Total reading count
		const totalReadings = await TemperatureReading.countDocuments();

		return {
			mocreoSensors: mocreoSensors.map((s: any) => {
				const reading = readingMap.get(s.thingName);
				const mapping = sensorToEquipment.get(s.thingName);
				return {
					sensorId: s.thingName,
					sensorName: s.name,
					model: s.model ?? 'ST5',
					temperature: reading?.temperature ?? null,
					humidity: reading?.humidity ?? null,
					lastReadingAt: reading?.timestamp ?? null,
					readingCount: reading?.readingCount ?? 0,
					mappedEquipmentId: mapping?.equipmentId ?? null,
					mappedEquipmentName: mapping?.equipmentName ?? null,
					mappedEquipmentType: mapping?.equipmentType ?? null
				};
			}),
			equipment: (equipment as any[]).map((e: any) => ({
				id: String(e._id),
				name: e.name,
				equipmentType: e.equipmentType,
				mocreoDeviceId: e.mocreoDeviceId ?? null,
				currentTemperatureC: e.currentTemperatureC ?? null,
				lastTemperatureReadAt: e.lastTemperatureReadAt ?? null,
				temperatureMinC: e.temperatureMinC ?? null,
				temperatureMaxC: e.temperatureMaxC ?? null
			})),
			totalReadings,
			isAdmin: isAdmin(locals.user)
		};
	} catch (err) {
		console.error('[TEMP PROBES] Load error:', err instanceof Error ? err.message : err);
		return { mocreoSensors: [], equipment: [], totalReadings: 0, isAdmin: isAdmin(locals.user) };
	}
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

		await Equipment.findByIdAndUpdate(equipmentId, 
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
