/**
 * Single canonical "is equipment X in use right now?" answer per PRD
 * Equipment Connectivity v2 §S4.
 *
 * `inUse` = actively LOCKED by an in-flight run (NOT "has inventory" — a
 * fridge with cartridges in it is not "in use" by this definition; capacity
 * is a separate concern). Manual override states like 'offline'/'maintenance'
 * are reported separately on `operationalState`, so UIs can show both.
 */
import { connectDB, WaxFillingRun, ReagentBatchRecord, BackingLot, Equipment, CartridgeRecord, LotRecord, TemperatureAlert } from '$lib/server/db';

export type EquipmentType = 'robot' | 'deck' | 'cooling_tray' | 'fridge' | 'oven';

export interface InUseState {
	inUse: boolean;
	reason: string | null;
	lockedByRunId: string | null;
	lockedUntil: Date | null;
	operationalState: 'active' | 'offline' | 'maintenance' | 'unknown';
}

const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];
const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection',
	'setup', 'loading', 'running', 'inspection'];
const WAX_NON_TERMINAL = [...WAX_PAGE_OWNED, 'QC', 'Storage', 'qc', 'storage'];

function mapOperationalState(status: string | undefined | null): InUseState['operationalState'] {
	if (!status) return 'unknown';
	if (status === 'offline') return 'offline';
	if (status === 'maintenance') return 'maintenance';
	return 'active';
}

export async function computeInUseState(equipmentId: string, equipmentType: EquipmentType): Promise<InUseState> {
	await connectDB();
	const equip = await Equipment.findById(equipmentId).select('status').lean() as any;
	const operationalState = mapOperationalState(equip?.status);

	const idle: Omit<InUseState, 'operationalState'> = {
		inUse: false, reason: null, lockedByRunId: null, lockedUntil: null
	};

	if (equipmentType === 'fridge') {
		// Fridges are never "in use" by lock — capacity is the separate concern.
		return { ...idle, operationalState };
	}

	if (equipmentType === 'robot') {
		const wax = await WaxFillingRun.findOne({ 'robot._id': equipmentId, status: { $in: WAX_PAGE_OWNED } })
			.select('_id status').lean() as any;
		if (wax) return { inUse: true, reason: `wax run ${wax.status}`, lockedByRunId: String(wax._id), lockedUntil: null, operationalState };
		const reagent = await ReagentBatchRecord.findOne({ 'robot._id': equipmentId, status: { $in: REAGENT_PAGE_OWNED } })
			.select('_id status').lean().catch(() => null) as any;
		if (reagent) return { inUse: true, reason: `reagent run ${reagent.status}`, lockedByRunId: String(reagent._id), lockedUntil: null, operationalState };
		return { ...idle, operationalState };
	}

	if (equipmentType === 'deck') {
		const wax = await WaxFillingRun.findOne({ deckId: equipmentId, status: { $in: WAX_PAGE_OWNED } })
			.select('_id status').lean() as any;
		if (wax) return { inUse: true, reason: `wax run ${wax.status}`, lockedByRunId: String(wax._id), lockedUntil: null, operationalState };
		const reagent = await ReagentBatchRecord.findOne({ deckId: equipmentId, status: { $in: REAGENT_PAGE_OWNED } })
			.select('_id status').lean().catch(() => null) as any;
		if (reagent) return { inUse: true, reason: `reagent run ${reagent.status}`, lockedByRunId: String(reagent._id), lockedUntil: null, operationalState };
		return { ...idle, operationalState };
	}

	if (equipmentType === 'cooling_tray') {
		const wax = await WaxFillingRun.findOne({ coolingTrayId: equipmentId, status: { $in: WAX_NON_TERMINAL } })
			.select('_id status').lean() as any;
		if (wax) return { inUse: true, reason: `wax run ${wax.status}`, lockedByRunId: String(wax._id), lockedUntil: null, operationalState };
		return { ...idle, operationalState };
	}

	if (equipmentType === 'oven') {
		const lot = await BackingLot.findOne({ ovenLocationId: equipmentId, status: { $in: ['in_oven', 'ready'] } })
			.select('_id status ovenEntryTime').lean() as any;
		if (lot) {
			return {
				inUse: true,
				reason: `backing lot ${lot.status}`,
				lockedByRunId: String(lot._id),
				lockedUntil: null,
				operationalState
			};
		}
		return { ...idle, operationalState };
	}

	return { ...idle, operationalState };
}

/**
 * Count how many records still reference this equipment. Used by S10's
 * delete-orphan guard. Joins on canonical _id first AND on legacy
 * name/barcode strings as a fallback so unmigrated records still register.
 */
export async function hasReferences(equipmentId: string, equipmentType: EquipmentType): Promise<{ total: number; breakdown: Record<string, number> }> {
	await connectDB();
	const equip = await Equipment.findById(equipmentId).select('name barcode').lean() as any;
	const legacyKeys = [equip?.name, equip?.barcode].filter(Boolean) as string[];

	const breakdown: Record<string, number> = {};
	if (equipmentType === 'fridge') {
		breakdown['cartridge_records.waxStorage'] = await CartridgeRecord.countDocuments({
			$or: [
				{ 'waxStorage.locationId': equipmentId },
				...(legacyKeys.length ? [{ 'waxStorage.location': { $in: legacyKeys } }] : [])
			]
		});
		breakdown['cartridge_records.storage'] = await CartridgeRecord.countDocuments({
			$or: [
				{ 'storage.fridgeId': equipmentId },
				{ 'storage.locationId': equipmentId },
				...(legacyKeys.length ? [{ 'storage.fridgeName': { $in: legacyKeys } }] : [])
			]
		});
		breakdown['temperature_alerts'] = await TemperatureAlert.countDocuments({ equipmentId }).catch(() => 0);
	} else if (equipmentType === 'oven') {
		breakdown['cartridge_records.ovenCure'] = await CartridgeRecord.countDocuments({ 'ovenCure.locationId': equipmentId });
		breakdown['backing_lots'] = await BackingLot.countDocuments({ ovenLocationId: equipmentId }).catch(() => 0);
		breakdown['lot_records'] = await LotRecord.countDocuments({ 'ovenPlacement.ovenId': equipmentId }).catch(() => 0);
		breakdown['temperature_alerts'] = await TemperatureAlert.countDocuments({ equipmentId }).catch(() => 0);
	} else if (equipmentType === 'robot') {
		breakdown['wax_filling_runs'] = await WaxFillingRun.countDocuments({ 'robot._id': equipmentId });
		breakdown['reagent_batch_records'] = await ReagentBatchRecord.countDocuments({ 'robot._id': equipmentId }).catch(() => 0);
	} else if (equipmentType === 'deck') {
		breakdown['wax_filling_runs'] = await WaxFillingRun.countDocuments({ deckId: equipmentId });
		breakdown['reagent_batch_records'] = await ReagentBatchRecord.countDocuments({ deckId: equipmentId }).catch(() => 0);
		breakdown['cartridge_records.waxFilling'] = await CartridgeRecord.countDocuments({ 'waxFilling.deckId': equipmentId });
	} else if (equipmentType === 'cooling_tray') {
		breakdown['wax_filling_runs'] = await WaxFillingRun.countDocuments({ coolingTrayId: equipmentId });
		breakdown['cartridge_records.waxStorage'] = await CartridgeRecord.countDocuments({ 'waxStorage.coolingTrayId': equipmentId });
	}

	const total = Object.values(breakdown).reduce((a, b) => a + b, 0);
	return { total, breakdown };
}
