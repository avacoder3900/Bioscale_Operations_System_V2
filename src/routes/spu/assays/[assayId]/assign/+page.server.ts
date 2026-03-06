import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const assay = await AssayDefinition.findById(params.assayId, {
		_id: 1, name: 1, skuCode: 1, assayId: 1
	}).lean() as any;
	if (!assay) throw error(404, 'Assay not found');

	// Fetch cartridges that haven't had an assay loaded yet
	const cartridges = await CartridgeRecord.find(
		{ 'assayLoaded.recordedAt': { $exists: false } },
		{ _id: 1, barcode: 1, lotNumber: 1 }
	).sort({ createdAt: -1 }).limit(200).lean();

	return {
		assay: {
			id: assay._id,
			assayId: assay.assayId ?? assay._id,
			name: assay.name,
			skuCode: assay.skuCode ?? null
		},
		cartridges: cartridges.map((c: any): { id: string; barcode: string; lotNumber: string } => ({
			id: c._id,
			barcode: c.barcode ?? '',
			lotNumber: c.lotNumber ?? ''
		}))
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const assay = await AssayDefinition.findById(params.assayId, {
			_id: 1, name: 1, skuCode: 1
		}).lean() as any;
		if (!assay) return fail(404, { error: 'Assay not found', assigned: 0, errors: [] });

		const data = await request.formData();
		const cartridgeIds = (data.get('cartridgeIds') as string)?.split(',').filter(Boolean) ?? [];
		const now = new Date();
		const errors: string[] = [];

		if (cartridgeIds.length) {
			const bulkOps = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'assayLoaded.recordedAt': { $exists: false } },
					update: {
						$set: {
							'assayLoaded.assay': { _id: assay._id, name: assay.name, skuCode: assay.skuCode },
							'assayLoaded.loadedAt': now,
							'assayLoaded.recordedAt': now,
							currentPhase: 'assay_loaded'
						}
					}
				}
			}));
			const result = await CartridgeRecord.bulkWrite(bulkOps);
			const assigned = result.modifiedCount;
			const skipped = cartridgeIds.length - assigned;
			if (skipped > 0) errors.push(`${skipped} cartridge(s) were already assigned or not found`);
			return { assigned, errors };
		}

		return { assigned: 0, errors: [] as string[] };
	}
};
