import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord } from '$lib/server/db';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';

const FRIDGES = ['fridge-1', 'fridge-2', 'fridge-3', 'fridge-4'] as const;
type FridgeId = typeof FRIDGES[number];

type StoredCartridge = {
	cartridgeId: string;
	containerBarcode: string | null;
	storedAt: string | null;
	status: string;
};

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	// Get cartridges awaiting storage (completed QC but not yet stored)
	const awaitingStorage = await CartridgeRecord.find(
		{ currentPhase: { $in: ['qc_complete', 'assay_loaded'] }, 'storage.storedAt': { $exists: false } },
		{ _id: 1, barcode: 1, lotNumber: 1 }
	).sort({ createdAt: -1 }).limit(500).lean();

	// Get stored cartridges grouped by fridge
	const storedCartridges = await CartridgeRecord.find(
		{ 'storage.fridgeId': { $in: FRIDGES } },
		{ _id: 1, 'storage.fridgeId': 1, 'storage.containerBarcode': 1, 'storage.storedAt': 1, status: 1 }
	).lean();

	const summary: Record<FridgeId, number> = {
		'fridge-1': 0,
		'fridge-2': 0,
		'fridge-3': 0,
		'fridge-4': 0
	};

	const fridgeDetails: Record<FridgeId, StoredCartridge[]> = {
		'fridge-1': [],
		'fridge-2': [],
		'fridge-3': [],
		'fridge-4': []
	};

	for (const c of storedCartridges as any[]) {
		const fridgeId = c.storage?.fridgeId as FridgeId;
		if (FRIDGES.includes(fridgeId)) {
			summary[fridgeId] = (summary[fridgeId] ?? 0) + 1;
			fridgeDetails[fridgeId].push({
				cartridgeId: c._id,
				containerBarcode: c.storage?.containerBarcode ?? null,
				storedAt: c.storage?.storedAt ? new Date(c.storage.storedAt).toISOString() : null,
				status: c.status ?? 'stored'
			});
		}
	}

	return {
		summary: summary as Record<string, number>,
		awaitingStorage: awaitingStorage.map((c: any) => ({
			cartridgeId: c._id,
			barcode: c.barcode ?? '',
			lotNumber: c.lotNumber ?? ''
		})),
		fridgeDetails: fridgeDetails as Record<string, StoredCartridge[]>
	};
};

export const actions: Actions = {
	store: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();

		const form = await request.formData();
		const cartridgeIds = form.getAll('cartridgeIds').map(String).filter(Boolean);
		const fridgeId = form.get('fridgeId')?.toString();
		const containerBarcode = form.get('containerBarcode')?.toString() || null;

		if (!fridgeId || !FRIDGES.includes(fridgeId as FridgeId)) {
			return fail(400, { error: 'Invalid fridge ID' });
		}
		if (!cartridgeIds.length) {
			return fail(400, { error: 'No cartridges selected' });
		}

		const now = new Date();
		await CartridgeRecord.updateMany(
			{ _id: { $in: cartridgeIds } },
			{
				$set: {
					'storage.fridgeId': fridgeId,
					'storage.containerBarcode': containerBarcode,
					'storage.storedAt': now,
					'storage.storedBy': locals.user?._id,
					currentPhase: 'stored',
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
				notes: `Stored in ${fridgeId}${containerBarcode ? `, container ${containerBarcode}` : ''}`
			});
		}

		return { message: `${cartridgeIds.length} cartridges stored in ${fridgeId}` };
	}
};

export const config = { maxDuration: 60 };
