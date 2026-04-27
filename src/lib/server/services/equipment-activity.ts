/**
 * S8 — Unified equipment activity feed.
 *
 * Merges into one chronological list:
 *   - DeviceEvent.find({ deviceId: equipmentId })
 *   - CartridgeRecord wax-storage events (waxStorage.locationId === equipmentId)
 *   - WaxFillingRun events keyed by deck/tray/robot/oven
 *   - BackingLot events (oven)
 *   - TemperatureAlert events (equipmentId)
 *   - ManualCartridgeRemoval — checkout events on cartridges that were stored
 *     in this fridge (added 2026-04-23)
 *
 * If an equipment is temp-sensitive (fridge/oven) and has no mocreoDeviceId
 * mapping, emit a `kind: 'mocreo_unmapped'` sentinel so missing mappings are
 * visible.
 *
 * Per PRD Equipment Connectivity v2 §S8.
 */
import {
	connectDB, DeviceEvent, CartridgeRecord, WaxFillingRun, BackingLot,
	TemperatureAlert, ManualCartridgeRemoval, Equipment
} from '$lib/server/db';

export interface ActivityEvent {
	at: Date;
	kind: string;
	source: string;
	summary: string;
	payload: Record<string, any>;
}

const DEFAULT_LIMIT = 200;
const DEFAULT_DAYS = 30;

export async function loadUnifiedActivity(
	equipmentId: string,
	opts: { since?: Date; limit?: number } = {}
): Promise<ActivityEvent[]> {
	await connectDB();
	const since = opts.since ?? new Date(Date.now() - DEFAULT_DAYS * 24 * 60 * 60 * 1000);
	const limit = opts.limit ?? DEFAULT_LIMIT;

	const equip = await Equipment.findById(equipmentId).select('equipmentType mocreoDeviceId').lean() as any;
	const events: ActivityEvent[] = [];

	// 1. DeviceEvent (Mocreo / device-level)
	const deviceEvents = await DeviceEvent.find({ deviceId: equipmentId, createdAt: { $gte: since } })
		.sort({ createdAt: -1 }).limit(limit).lean().catch(() => []) as any[];
	for (const e of deviceEvents) {
		events.push({
			at: e.createdAt ?? e.timestamp ?? new Date(),
			kind: e.eventType ?? 'device_event',
			source: 'device_events',
			summary: e.summary ?? e.message ?? `Device event: ${e.eventType ?? 'unknown'}`,
			payload: e
		});
	}

	// 2. CartridgeRecord wax-storage events
	const waxStored = await CartridgeRecord.find({
		'waxStorage.locationId': equipmentId,
		'waxStorage.recordedAt': { $gte: since }
	}).select({ _id: 1, 'waxStorage.recordedAt': 1, 'waxStorage.operator': 1 }).lean().catch(() => []) as any[];
	const waxStoredCartIds: string[] = [];
	for (const c of waxStored) {
		waxStoredCartIds.push(String(c._id));
		events.push({
			at: c.waxStorage?.recordedAt ?? new Date(),
			kind: 'cartridge_wax_stored',
			source: 'cartridge_records',
			summary: `Cartridge ${c._id} wax-stored (operator: ${c.waxStorage?.operator?.username ?? 'unknown'})`,
			payload: { cartridgeId: c._id }
		});
	}

	// 3. WaxFillingRun events
	const waxRuns = await WaxFillingRun.find({
		$or: [
			{ deckId: equipmentId },
			{ coolingTrayId: equipmentId },
			{ 'robot._id': equipmentId },
			{ ovenLocationId: equipmentId }
		],
		createdAt: { $gte: since }
	}).sort({ createdAt: -1 }).limit(limit).lean().catch(() => []) as any[];
	for (const r of waxRuns) {
		events.push({
			at: r.createdAt ?? new Date(),
			kind: 'wax_run',
			source: 'wax_filling_runs',
			summary: `Wax run ${r._id} status=${r.status} robot=${r.robot?.name ?? r.robot?._id ?? '?'}`,
			payload: r
		});
	}

	// 4. BackingLot events (oven)
	const backingLots = await BackingLot.find({ ovenLocationId: equipmentId, ovenEntryTime: { $gte: since } })
		.sort({ ovenEntryTime: -1 }).limit(limit).lean().catch(() => []) as any[];
	for (const b of backingLots) {
		events.push({
			at: b.ovenEntryTime ?? new Date(),
			kind: 'backing_lot',
			source: 'backing_lots',
			summary: `Backing lot ${b._id} status=${b.status} cartridges=${b.cartridgeCount ?? 0}`,
			payload: b
		});
	}

	// 5. TemperatureAlert events
	const alerts = await TemperatureAlert.find({ equipmentId, createdAt: { $gte: since } })
		.sort({ createdAt: -1 }).limit(limit).lean().catch(() => []) as any[];
	for (const a of alerts) {
		events.push({
			at: a.createdAt ?? new Date(),
			kind: 'temperature_alert',
			source: 'temperature_alerts',
			summary: `Temp alert: ${a.alertType ?? a.kind ?? 'unknown'} ${a.value !== undefined ? `(${a.value})` : ''}`,
			payload: a
		});
	}

	// 6. ManualCartridgeRemoval — only show if a cartridge in this fridge was checked out
	if (waxStoredCartIds.length > 0) {
		const removals = await ManualCartridgeRemoval.find({
			cartridgeIds: { $in: waxStoredCartIds },
			removedAt: { $gte: since }
		}).sort({ removedAt: -1 }).limit(limit).lean().catch(() => []) as any[];
		for (const r of removals) {
			const cartList = (r.cartridgeIds ?? []).filter((id: string) => waxStoredCartIds.includes(id));
			events.push({
				at: r.removedAt ?? new Date(),
				kind: 'cartridge_checkout',
				source: 'manual_cartridge_removals',
				summary: `Cartridge${cartList.length === 1 ? '' : 's'} ${cartList.join(', ')} checked out — ${r.reason}`,
				payload: r
			});
		}
	}

	// 7. Mocreo-unmapped sentinel
	if ((equip?.equipmentType === 'fridge' || equip?.equipmentType === 'oven') && !equip?.mocreoDeviceId) {
		events.push({
			at: new Date(),
			kind: 'mocreo_unmapped',
			source: 'sentinel',
			summary: 'No Mocreo device mapped — temperature history unavailable',
			payload: { equipmentId, equipmentType: equip?.equipmentType }
		});
	}

	// Sort merged feed chronologically (newest first), cap at limit
	events.sort((a, b) => b.at.getTime() - a.at.getTime());
	return events.slice(0, limit);
}
