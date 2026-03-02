import { error, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const assay = await AssayDefinition.findById(params.assayId, { _id: 1, name: 1, skuCode: 1 }).lean() as any;
	if (!assay) throw error(404, 'Assay not found');

	return {
		assay: { id: assay._id, name: assay.name, skuCode: assay.skuCode ?? null }
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const assay = await AssayDefinition.findById(params.assayId, { _id: 1, name: 1, skuCode: 1 }).lean() as any;
		if (!assay) throw error(404, 'Assay not found');

		const data = await request.formData();
		const cartridgeIds = (data.get('cartridgeIds') as string)?.split(',').filter(Boolean) ?? [];
		const now = new Date();

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
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true, assignedCount: cartridgeIds.length };
	}
};
