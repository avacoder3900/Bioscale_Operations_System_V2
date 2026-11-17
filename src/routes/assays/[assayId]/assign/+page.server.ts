import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition, CartridgeRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { withNotCustomerHeld, findCustomerHeldIds, customerHeldNotice } from '$lib/server/manufacturing/locked-cartridges';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'assay:read');
	await connectDB();

	const assay = await AssayDefinition.findById(params.assayId, {
		_id: 1, name: 1, skuCode: 1, assayId: 1
	}).lean() as any;
	if (!assay) throw error(404, 'Assay not found');

	// Fetch cartridges that haven't had an assay loaded yet — never one a
	// customer has linked (customer-held.ts)
	const cartridges = await CartridgeRecord.find(
		withNotCustomerHeld({ 'assayLoaded.recordedAt': { $exists: false } }),
		{ _id: 1, barcode: 1, lotNumber: 1, status: 1, cartridgeType: 1 }
	).sort({ createdAt: -1 }).limit(200).lean();

	return {
		assay: {
			id: assay._id,
			assayId: assay.assayId ?? assay._id,
			name: assay.name,
			skuCode: assay.skuCode ?? null
		},
		cartridges: cartridges.map((c: any) => ({
			id: c._id,
			barcode: c.barcode ?? '',
			lotNumber: c.lotNumber ?? '',
			status: c.status ?? 'unknown',
			cartridgeType: c.cartridgeType ?? null
		}))
	};
};

export const actions: Actions = {
	default: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'assay:write');
		await connectDB();

		const assay = await AssayDefinition.findById(params.assayId, {
			_id: 1, name: 1, skuCode: 1
		}).lean() as any;
		if (!assay) return fail(404, { error: 'Assay not found', assigned: 0, errors: [] as string[] });

		const data = await request.formData();
		const cartridgeIds = (data.get('cartridgeIds') as string)?.split(',').filter(Boolean) ?? [];
		const now = new Date();
		const errors: string[] = [];

		if (cartridgeIds.length) {
			// A cartridge a customer has linked is refused outright: it is never
			// pulled back to linked under another assay. The guard is in each
			// filter too, so a link made after this read still wins.
			const held = await findCustomerHeldIds(cartridgeIds);
			const heldSet = new Set(held);
			const heldNotice = customerHeldNotice('assigned', held);
			if (heldNotice) errors.push(heldNotice);
			const toAssign = cartridgeIds.filter((cid) => !heldSet.has(cid));
			if (!toAssign.length) return { success: true, assigned: 0, errors };
			const bulkOps = toAssign.map((cid: string) => ({
				updateOne: {
					filter: withNotCustomerHeld({ _id: cid, 'assayLoaded.recordedAt': { $exists: false } }),
					update: {
						$set: {
							'assayLoaded.assay': { _id: assay._id, name: assay.name, skuCode: assay.skuCode },
							'assayLoaded.loadedAt': now,
							'assayLoaded.recordedAt': now,
							status: 'linked'
						}
					}
				}
			}));
			const result = await CartridgeRecord.bulkWrite(bulkOps as any);
			const assigned = result.modifiedCount;
			const skipped = toAssign.length - assigned;
			if (skipped > 0) errors.push(`${skipped} cartridge(s) were already assigned or not found`);
			return { success: true, assigned, errors };
		}

		return { success: true, assigned: 0, errors: [] as string[] };
	}
};

export const config = { maxDuration: 60 };
