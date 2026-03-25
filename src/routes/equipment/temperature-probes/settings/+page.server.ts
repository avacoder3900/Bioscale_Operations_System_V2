export const config = { maxDuration: 60 };
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, Equipment, SensorConfig, ManufacturingSettings, generateId, AuditLog } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!isAdmin(locals.user)) throw redirect(303, '/equipment/temperature-probes');
	await connectDB();

	// Get all equipment for mapping dropdown
	const equipment = await Equipment.find({ status: { $ne: 'retired' } })
		.sort({ equipmentType: 1, name: 1 })
		.select('_id name equipmentType mocreoDeviceId temperatureMinC temperatureMaxC')
		.lean() as any[];

	// Get all sensor configs
	const sensorConfigs = await SensorConfig.find().lean() as any[];
	const sensorConfigMap = new Map<string, any>();
	for (const sc of sensorConfigs) sensorConfigMap.set(sc._id, sc);

	// Get Mocreo sensors
	let mocreoSensors: any[] = [];
	try {
		const { fetchAllSensors } = await import('$lib/server/services/mocreo');
		mocreoSensors = await fetchAllSensors();
	} catch {
		// Mocreo API unavailable
	}

	// Build combined sensor list
	const sensors = mocreoSensors.map(s => {
		const sc = sensorConfigMap.get(s.thingName);
		const mappedEq = equipment.find((e: any) =>
			e.mocreoDeviceId === s.thingName || (sc?.mappedEquipmentId && String(e._id) === sc.mappedEquipmentId)
		);

		// Extract Mocreo thresholds from sensor info
		const mocreoThresholds = {
			min: s.info?.temperature?.min != null ? s.info.temperature.min / 100 : null,
			max: s.info?.temperature?.max != null ? s.info.temperature.max / 100 : null
		};

		return {
			sensorId: s.thingName,
			sensorName: s.name,
			model: s.model ?? 'ST5',
			temperatureMinC: sc?.temperatureMinC ?? mappedEq?.temperatureMinC ?? null,
			temperatureMaxC: sc?.temperatureMaxC ?? mappedEq?.temperatureMaxC ?? null,
			alertsEnabled: sc?.alertsEnabled ?? true,
			emailRecipients: sc?.emailRecipients ?? [],
			mappedEquipmentId: sc?.mappedEquipmentId ?? (mappedEq ? String(mappedEq._id) : null),
			mappedEquipmentName: mappedEq?.name ?? null,
			mocreoThresholds
		};
	});

	// Get global email recipients
	const settings = await ManufacturingSettings.findById('default').lean() as any;
	const globalEmailRecipients = settings?.temperatureAlerts?.emailRecipients ?? [];

	return {
		sensors: JSON.parse(JSON.stringify(sensors)),
		equipment: equipment.map((e: any) => ({
			id: String(e._id),
			name: e.name,
			equipmentType: e.equipmentType
		})),
		globalEmailRecipients,
		isAdmin: true
	};
};

export const actions: Actions = {
	saveAll: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const sensorsJson = data.get('sensors')?.toString();
		if (!sensorsJson) return fail(400, { error: 'No sensor data provided' });

		let sensors: any[];
		try {
			sensors = JSON.parse(sensorsJson);
		} catch {
			return fail(400, { error: 'Invalid sensor data' });
		}

		for (const s of sensors) {
			const update: any = {
				_id: s.sensorId,
				sensorName: s.sensorName,
				temperatureMinC: s.temperatureMinC != null && s.temperatureMinC !== '' ? parseFloat(s.temperatureMinC) : null,
				temperatureMaxC: s.temperatureMaxC != null && s.temperatureMaxC !== '' ? parseFloat(s.temperatureMaxC) : null,
				alertsEnabled: s.alertsEnabled !== false,
				emailRecipients: Array.isArray(s.emailRecipients) ? s.emailRecipients : [],
				mappedEquipmentId: s.mappedEquipmentId || null,
				updatedAt: new Date()
			};

			await SensorConfig.findByIdAndUpdate(s.sensorId, update, { upsert: true });

			// Also update Equipment mapping if changed
			if (s.mappedEquipmentId) {
				// Clear old mapping
				await Equipment.updateMany(
					{ mocreoDeviceId: s.sensorId, _id: { $ne: s.mappedEquipmentId } },
					{ $unset: { mocreoDeviceId: 1 } }
				);
				await Equipment.findByIdAndUpdate(s.mappedEquipmentId, {
					mocreoDeviceId: s.sensorId,
					temperatureMinC: update.temperatureMinC,
					temperatureMaxC: update.temperatureMaxC
				});
			}
		}

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'sensor_configs',
			recordId: 'bulk_update',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: { sensorCount: sensors.length }
		});

		return { success: true };
	},

	saveEmails: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const emailsRaw = data.get('emailRecipients')?.toString() ?? '';
		const emails = emailsRaw.split(',').map(e => e.trim()).filter(Boolean);

		await ManufacturingSettings.findByIdAndUpdate('default', {
			'temperatureAlerts.emailRecipients': emails,
			updatedAt: new Date()
		}, { upsert: true });

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'manufacturing_settings',
			recordId: 'default',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: { temperatureAlerts: { emailRecipients: emails } }
		});

		return { success: true, emailsSaved: true };
	},

	importThresholds: async ({ locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		let mocreoSensors: any[];
		try {
			const { fetchAllSensors } = await import('$lib/server/services/mocreo');
			mocreoSensors = await fetchAllSensors();
		} catch (err: any) {
			return fail(500, { error: 'Failed to fetch Mocreo sensors: ' + (err.message || 'Unknown') });
		}

		let imported = 0;
		for (const s of mocreoSensors) {
			const minRaw = s.info?.temperature?.min;
			const maxRaw = s.info?.temperature?.max;
			if (minRaw == null && maxRaw == null) continue;

			const minC = minRaw != null ? minRaw / 100 : null;
			const maxC = maxRaw != null ? maxRaw / 100 : null;

			// Only set if current config is empty
			const existing = await SensorConfig.findById(s.thingName).lean() as any;
			const update: any = { sensorName: s.name, updatedAt: new Date() };
			if ((existing?.temperatureMinC == null) && minC != null) update.temperatureMinC = minC;
			if ((existing?.temperatureMaxC == null) && maxC != null) update.temperatureMaxC = maxC;

			if (update.temperatureMinC != null || update.temperatureMaxC != null) {
				await SensorConfig.findByIdAndUpdate(s.thingName, { $set: update }, { upsert: true });
				imported++;
			}
		}

		await AuditLog.create({
			_id: generateId(),
			action: 'IMPORT',
			tableName: 'sensor_configs',
			recordId: 'mocreo_thresholds',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date(),
			newData: { importedCount: imported }
		});

		return { success: true, imported };
	}
};
