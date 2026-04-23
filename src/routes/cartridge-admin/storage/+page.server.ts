import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, Equipment, EquipmentLocation, AuditLog, generateId } from '$lib/server/db';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';

type StoredCartridge = {
	cartridgeId: string;
	containerBarcode: string | null;
	storedAt: string | null;
	status: string;
};

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Get parent fridges from Equipment, plus orphan EquipmentLocations
	const [equipDocs, locationDocs] = await Promise.all([
		Equipment.find({ equipmentType: 'fridge', status: { $ne: 'offline' } }).sort({ name: 1 }).lean(),
		EquipmentLocation.find({ locationType: 'fridge', isActive: true }).lean()
	]);

	const fridges: { id: string; displayName: string; barcode: string }[] = [];
	const parentIds = new Set((equipDocs as any[]).map((e: any) => String(e._id)));

	for (const equip of equipDocs as any[]) {
		fridges.push({
			id: String(equip._id),
			displayName: equip.name ?? equip.barcode ?? String(equip._id),
			barcode: equip.barcode ?? ''
		});
	}
	// Add orphan locations (no parentEquipmentId or parent not in equipment)
	for (const loc of locationDocs as any[]) {
		if (!loc.parentEquipmentId || !parentIds.has(loc.parentEquipmentId)) {
			fridges.push({
				id: String(loc._id),
				displayName: loc.displayName ?? loc.barcode ?? String(loc._id),
				barcode: loc.barcode ?? ''
			});
		}
	}

	// Get cartridges awaiting storage (completed QC but not yet stored)
	const awaitingStorage = await CartridgeRecord.find(
		{ status: { $in: ['released', 'linked'] }, 'storage.fridgeName': { $exists: false } },
		{ _id: 1, barcode: 1, lotNumber: 1 }
	).sort({ createdAt: -1 }).limit(500).lean();

	// Get stored cartridges grouped by fridge (using storage.fridgeName — the field the rest of the system uses).
	// Status filter excludes terminal states (shipped/completed/voided/scrapped) whose
	// storage.fridgeName is just a stale historical reference — the physical cartridge
	// has long left the fridge. Matches the filter used on /equipment/activity.
	const fridgeKeys = fridges.map((f) => f.barcode || f.displayName);
	const storedCartridges = await CartridgeRecord.find(
		{
			'storage.fridgeName': { $in: fridgeKeys },
			status: { $in: ['stored', 'reagent_filled', 'released', 'linked'] }
		},
		{ _id: 1, 'storage.fridgeName': 1, 'storage.containerBarcode': 1, 'storage.storedAt': 1, 'storage.recordedAt': 1, status: 1 }
	).lean();

	const summary: Record<string, number> = {};
	const fridgeDetails: Record<string, StoredCartridge[]> = {};
	for (const f of fridges) {
		const key = f.barcode || f.displayName;
		summary[key] = 0;
		fridgeDetails[key] = [];
	}

	for (const c of storedCartridges as any[]) {
		const key = c.storage?.fridgeName;
		if (key && key in summary) {
			summary[key] = (summary[key] ?? 0) + 1;
			fridgeDetails[key].push({
				cartridgeId: c._id,
				containerBarcode: c.storage?.containerBarcode ?? null,
				storedAt: (c.storage?.storedAt ?? c.storage?.recordedAt) ? new Date(c.storage.storedAt ?? c.storage.recordedAt).toISOString() : null,
				status: c.status ?? 'stored'
			});
		}
	}

	return {
		fridges,
		summary,
		awaitingStorage: awaitingStorage.map((c: any) => ({
			cartridgeId: c._id,
			barcode: c.barcode ?? '',
			lotNumber: c.lotNumber ?? ''
		})),
		fridgeDetails
	};
};

export const actions: Actions = {
	store: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const cartridgeIds = form.getAll('cartridgeIds').map(String).filter(Boolean);
		const fridgeKey = form.get('fridgeId')?.toString();
		const containerBarcode = form.get('containerBarcode')?.toString() || null;

		if (!fridgeKey) {
			return fail(400, { error: 'Fridge selection is required' });
		}
		if (!cartridgeIds.length) {
			return fail(400, { error: 'No cartridges selected' });
		}

		const now = new Date();
		await CartridgeRecord.updateMany(
			{ _id: { $in: cartridgeIds } },
			{
				$set: {
					'storage.fridgeName': fridgeKey,       // barcode string — for fridgeName-based queries
					'storage.locationId': fridgeKey,       // same value — for locationId-based queries
					'storage.containerBarcode': containerBarcode,
					'storage.storedAt': now,
					'storage.recordedAt': now,
					'storage.storedBy': locals.user?._id,
					status: 'stored'
				}
			}
		);

		// Record storage transactions
		for (const cid of cartridgeIds) {
			await recordTransaction({
				transactionType: 'creation',
				cartridgeRecordId: cid,
				quantity: 1,
				manufacturingStep: 'storage',
				operatorId: locals.user?._id,
				operatorUsername: locals.user?.username,
				notes: `Stored in ${fridgeKey}${containerBarcode ? `, container ${containerBarcode}` : ''}`
			});
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cid,
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
		}

		return { message: `${cartridgeIds.length} cartridges stored in ${fridgeKey}` };
	}
};

export const config = { maxDuration: 60 };
