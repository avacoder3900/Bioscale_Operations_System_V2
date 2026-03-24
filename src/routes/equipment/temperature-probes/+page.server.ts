export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, Equipment, TemperatureReading, generateId, AuditLog } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	try {
		await connectDB();
		const equipment = await Equipment.find().sort({ name: 1 }).lean();

		// Get recent readings (last 2 hours) for all sensors with mocreoDeviceId
		const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
		const recentReadings = await TemperatureReading.find({ timestamp: { $gte: twoHoursAgo } })
			.sort({ timestamp: -1 })
			.limit(200)
			.select('sensorId sensorName temperature humidity timestamp equipmentId')
			.lean();

		return {
			sensors: (equipment as any[]).map((e: any) => ({
				equipmentId: e._id,
				name: e.name ?? null,
				equipmentType: e.equipmentType ?? 'unknown',
				mocreoDeviceId: e.mocreoDeviceId ?? null,
				currentTemperature: e.currentTemperatureC ?? null,
				temperatureMinC: e.temperatureMinC ?? null,
				temperatureMaxC: e.temperatureMaxC ?? null,
				targetTemperature: e.temperatureMaxC ?? null,
				lastReadingAt: e.lastTemperatureReadAt ?? null,
				status: e.status ?? 'active',
				isActive: e.isActive ?? true
			})),
			recentReadings: JSON.parse(JSON.stringify(recentReadings)),
			isAdmin: isAdmin(locals.user)
		};
	} catch (err) {
		console.error('[TEMP PROBES] Load error:', err instanceof Error ? err.message : err);
		return { sensors: [], recentReadings: [], isAdmin: isAdmin(locals.user) };
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

		await Equipment.findByIdAndUpdate(equipmentId, {
			mocreoDeviceId: mocreoDeviceId ?? undefined,
			...(mocreoDeviceId ? {} : { $unset: { mocreoDeviceId: 1 } })
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'equipment',
			recordId: equipmentId,
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: { mocreoDeviceId }
		});

		return { success: true, message: 'Sensor mapping updated' };
	}
};
