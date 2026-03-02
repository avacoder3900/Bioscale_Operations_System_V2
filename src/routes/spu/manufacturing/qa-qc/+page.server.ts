import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, ReagentBatchRecord } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Cartridges pending QA/QC release
	const pendingCartridges = await CartridgeRecord.find({
		currentPhase: { $in: ['stored', 'cured'] },
		'qaqcRelease.recordedAt': { $exists: false }
	}).sort({ createdAt: -1 }).limit(100).lean();

	return {
		inspections: pendingCartridges.map((c: any) => ({
			id: c._id,
			cartridgeId: c._id,
			lotId: c.backing?.lotId ?? null,
			status: c.qaqcRelease?.testResult ?? 'pending',
			result: c.qaqcRelease?.testResult ?? null,
			inspectedAt: c.qaqcRelease?.testedAt ?? null,
			inspectorName: c.qaqcRelease?.testedBy?.username ?? null,
			notes: c.qaqcRelease?.notes ?? null
		}))
	};
};

export const actions: Actions = {
	release: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const testResult = data.get('testResult') as string;
		const shippingLotId = data.get('shippingLotId') as string;
		const notes = data.get('notes') as string;

		// WRITE-ONCE qaqcRelease phase
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'qaqcRelease.recordedAt': { $exists: false } },
			{
				$set: {
					'qaqcRelease.shippingLotId': shippingLotId || undefined,
					'qaqcRelease.testResult': testResult,
					'qaqcRelease.testedBy': { _id: locals.user._id, username: locals.user.username },
					'qaqcRelease.testedAt': new Date(),
					'qaqcRelease.notes': notes || undefined,
					'qaqcRelease.recordedAt': new Date(),
					currentPhase: testResult === 'pass' ? 'released' : 'voided'
				}
			}
		);

		return { success: true };
	}
};
