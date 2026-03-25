export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import { connectDB, Equipment, TemperatureReading, TemperatureAlert, generateId, AuditLog } from '$lib/server/db';
import { isAdmin, requirePermission } from '$lib/server/permissions';
import {
	fetchLatestReading,
	rawToC,
	rawToHumidity
} from '$lib/server/services/mocreo';
import type { PageServerLoad, Actions } from './$types';

/** Transform Mocreo device ID: MC prefix → 00 prefix + 00 suffix, lowercase */
function transformNodeId(mocreoDeviceId: string): string {
	if (mocreoDeviceId.startsWith('MC')) {
		return ('00' + mocreoDeviceId.slice(2) + '00').toLowerCase();
	}
	return mocreoDeviceId.toLowerCase();
}

export const load: PageServerLoad = async (event) => {
	requirePermission(event.locals.user, 'equipment:read');
	try {
		await connectDB();

		const now = new Date();
		const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

		const [equipmentDocs, recentReadingDocs, activeAlerts] = await Promise.all([
			Equipment.find({
				equipmentType: { $in: ['fridge', 'oven'] }
			}).sort({ name: 1 }).lean() as Promise<any[]>,

			TemperatureReading.find({
				timestamp: { $gte: twentyFourHoursAgo }
			}).sort({ timestamp: -1 }).lean() as Promise<any[]>,

			TemperatureAlert.find({
				acknowledged: false
			}).sort({ timestamp: -1 }).lean() as Promise<any[]>
		]);

		// Build 24h stats per equipment + track latest battery/signal from readings
		const statsByEquipment = new Map<string, { min: number; max: number; sum: number; count: number; sparkline: number[] }>();
		const latestMetaByEquipment = new Map<string, { batteryLevel: number | null; signalLevel: number | null }>();
		for (const r of recentReadingDocs) {
			if (r.equipmentId && r.temperature != null) {
				const key = String(r.equipmentId);
				let stats = statsByEquipment.get(key);
				if (!stats) {
					stats = { min: Infinity, max: -Infinity, sum: 0, count: 0, sparkline: [] };
					statsByEquipment.set(key, stats);
				}
				stats.min = Math.min(stats.min, r.temperature);
				stats.max = Math.max(stats.max, r.temperature);
				stats.sum += r.temperature;
				stats.count++;
				stats.sparkline.push(r.temperature);
				// Track battery/signal from most recent reading (first one since sorted desc)
				if (!latestMetaByEquipment.has(key)) {
					latestMetaByEquipment.set(key, {
						batteryLevel: r.batteryLevel ?? null,
						signalLevel: r.signalLevel ?? null
					});
				}
			}
		}
		
		// Also build battery/signal lookup by sensorId for unmapped sensors
		const latestMetaBySensor = new Map<string, { batteryLevel: number | null; signalLevel: number | null }>();
		for (const r of recentReadingDocs) {
			if (r.sensorId && !latestMetaBySensor.has(r.sensorId)) {
				latestMetaBySensor.set(r.sensorId, {
					batteryLevel: r.batteryLevel ?? null,
					signalLevel: r.signalLevel ?? null
				});
			}
		}

		// Reverse sparklines so they go oldest→newest
		for (const stats of statsByEquipment.values()) {
			stats.sparkline.reverse();
			// Downsample to ~24 points for mini chart
			if (stats.sparkline.length > 24) {
				const step = stats.sparkline.length / 24;
				const sampled: number[] = [];
				for (let i = 0; i < 24; i++) {
					sampled.push(stats.sparkline[Math.floor(i * step)]);
				}
				stats.sparkline = sampled;
			}
		}

		const sensors = (equipmentDocs).map((e: any) => {
			const stats = statsByEquipment.get(String(e._id));
			const lastReadAt = e.lastTemperatureReadAt ? new Date(e.lastTemperatureReadAt) : null;
			const timeoutMs = (e.connectionTimeoutMinutes ?? 30) * 60 * 1000;
			const isOffline = lastReadAt ? (now.getTime() - lastReadAt.getTime() > timeoutMs) : false;
			const minutesSinceLastRead = lastReadAt ? Math.round((now.getTime() - lastReadAt.getTime()) / 60000) : null;

			return {
				equipmentId: e._id,
				name: e.name ?? null,
				equipmentType: e.equipmentType ?? 'unknown',
				mocreoDeviceId: e.mocreoDeviceId ?? null,
				mocreoAssetId: e.mocreoAssetId ?? null,
				currentTemperatureC: e.currentTemperatureC ?? null,
				temperatureMinC: e.temperatureMinC ?? null,
				temperatureMaxC: e.temperatureMaxC ?? null,
				lastTemperatureReadAt: e.lastTemperatureReadAt ?? null,
				status: e.status ?? 'active',
				isActive: e.isActive ?? true,
				alertsEnabled: e.alertsEnabled ?? false,
				connectionTimeoutMinutes: e.connectionTimeoutMinutes ?? 30,
				notes: e.notes ?? null,
				// 24h stats
				stats24h: stats ? {
					min: Math.round(stats.min * 10) / 10,
					max: Math.round(stats.max * 10) / 10,
					avg: Math.round((stats.sum / stats.count) * 10) / 10,
					sparkline: stats.sparkline.map(v => Math.round(v * 10) / 10)
				} : null,
				// Connection status
				isOffline,
				minutesSinceLastRead,
				// Battery/signal from readings or mocreoMeta
				batteryLevel: latestMetaByEquipment.get(String(e._id))?.batteryLevel ?? latestMetaBySensor.get(e.mocreoDeviceId)?.batteryLevel ?? e.mocreoMeta?.batteryLevel ?? null,
				signalLevel: latestMetaByEquipment.get(String(e._id))?.signalLevel ?? latestMetaBySensor.get(e.mocreoDeviceId)?.signalLevel ?? e.mocreoMeta?.signalLevel ?? null
			};
		});

		// Recent readings for table (last 50)
		const recentReadings = recentReadingDocs.slice(0, 50).map((r: any) => ({
			id: r._id,
			equipmentId: r.equipmentId ?? null,
			temperatureC: r.temperature ?? null,
			humidity: r.humidity ?? null,
			description: r.sensorName ?? null,
			createdAt: r.timestamp ?? r.createdAt
		}));

		return {
			sensors: JSON.parse(JSON.stringify(sensors)),
			recentReadings: JSON.parse(JSON.stringify(recentReadings)),
			alerts: JSON.parse(JSON.stringify(activeAlerts)),
			isAdmin: isAdmin(event.locals.user)
		};
	} catch (err) {
		console.error('[TEMP PROBES] Load error:', err instanceof Error ? err.message : err);
		return { sensors: [], recentReadings: [], alerts: [], isAdmin: isAdmin(event.locals.user) };
	}
};

export const actions: Actions = {
	ping: async (event) => {
		requirePermission(event.locals.user, 'equipment:read');
		await connectDB();

		const data = await event.request.formData();
		const equipmentId = data.get('equipmentId')?.toString();
		if (!equipmentId) return fail(400, { error: 'equipmentId is required' });

		const equipment = await Equipment.findById(equipmentId).lean() as any;
		if (!equipment?.mocreoDeviceId) {
			return fail(400, { error: 'Equipment has no MOCREO device linked' });
		}

		try {
			const nodeId = transformNodeId(equipment.mocreoDeviceId);
			const sample = await fetchLatestReading(nodeId);
			if (!sample) {
				return fail(400, { error: 'No reading available from sensor' });
			}

			const temperature = sample.data.tm != null ? rawToC(sample.data.tm) : null;
			const humidity = sample.data.hm != null ? rawToHumidity(sample.data.hm) : null;
			const timestamp = new Date(sample.time * 1000);

			await TemperatureReading.create({
				_id: generateId(),
				sensorId: equipment.mocreoDeviceId,
				sensorName: equipment.name,
				temperature,
				humidity,
				rawTemp: sample.data.tm ?? null,
				rawHumidity: sample.data.hm ?? null,
				timestamp,
				equipmentId
			});

			if (temperature != null) {
				await Equipment.findByIdAndUpdate(equipmentId, {
					currentTemperatureC: temperature,
					lastTemperatureReadAt: timestamp
				});
			}

			return { success: true, temperature, humidity, timestamp: timestamp.toISOString() };
		} catch (err) {
			console.error('[TEMP PROBES] Ping error:', err instanceof Error ? err.message : err);
			return fail(500, { error: 'Failed to ping sensor' });
		}
	},

	updateAlertSettings: async (event) => {
		requirePermission(event.locals.user, 'equipment:write');
		await connectDB();

		const data = await event.request.formData();
		const equipmentId = data.get('equipmentId')?.toString();
		if (!equipmentId) return fail(400, { error: 'equipmentId is required' });

		const alertsEnabled = data.get('alertsEnabled') === 'true';
		const temperatureMinC = data.get('temperatureMinC')?.toString();
		const temperatureMaxC = data.get('temperatureMaxC')?.toString();
		const connectionTimeoutMinutes = data.get('connectionTimeoutMinutes')?.toString();

		const update: Record<string, any> = { alertsEnabled };
		if (temperatureMinC) update.temperatureMinC = parseFloat(temperatureMinC);
		if (temperatureMaxC) update.temperatureMaxC = parseFloat(temperatureMaxC);
		if (connectionTimeoutMinutes) update.connectionTimeoutMinutes = parseInt(connectionTimeoutMinutes, 10);

		await Equipment.findByIdAndUpdate(equipmentId, update);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'equipment',
			recordId: equipmentId,
			action: 'UPDATE',
			newData: update,
			changedAt: new Date(),
			changedBy: event.locals.user?.username ?? 'unknown',
			changedFields: Object.keys(update)
		});

		return { success: true };
	},

	acknowledgeAlert: async (event) => {
		requirePermission(event.locals.user, 'equipment:write');
		await connectDB();

		const data = await event.request.formData();
		const alertId = data.get('alertId')?.toString();
		if (!alertId) return fail(400, { error: 'alertId is required' });

		const alert = await TemperatureAlert.findByIdAndUpdate(
			alertId,
			{
				acknowledged: true,
				acknowledgedBy: { _id: event.locals.user?._id, username: event.locals.user?.username },
				acknowledgedAt: new Date()
			},
			{ new: true }
		).lean();

		if (!alert) return fail(404, { error: 'Alert not found' });

		return { success: true };
	}
};
