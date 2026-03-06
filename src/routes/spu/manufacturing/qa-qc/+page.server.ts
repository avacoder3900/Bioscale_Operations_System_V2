import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, ReagentBatchRecord, LabCartridge, generateId } from '$lib/server/db';
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
		const now = new Date();

		// WRITE-ONCE qaqcRelease phase
		const updated = await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'qaqcRelease.recordedAt': { $exists: false } },
			{
				$set: {
					'qaqcRelease.shippingLotId': shippingLotId || undefined,
					'qaqcRelease.testResult': testResult,
					'qaqcRelease.testedBy': { _id: locals.user._id, username: locals.user.username },
					'qaqcRelease.testedAt': now,
					'qaqcRelease.notes': notes || undefined,
					'qaqcRelease.recordedAt': now,
					currentPhase: testResult === 'pass' ? 'released' : 'voided'
				}
			},
			{ new: true }
		).lean() as any;

		// FIX-06: Bridge CartridgeRecord → LabCartridge on pass
		if (updated && testResult === 'pass') {
			const lotNumber = updated.backing?.lotQrCode ?? updated.backing?.lotId ?? cartridgeId;
			const performedBy = { _id: locals.user._id, username: locals.user.username };

			await LabCartridge.findByIdAndUpdate(
				cartridgeId,
				{
					$setOnInsert: {
						_id: cartridgeId,
						lotNumber,
						cartridgeType: 'measurement',
						status: 'available',
						receivedDate: now,
						isActive: true,
						createdBy: locals.user._id
					},
					$push: {
						usageLog: {
							_id: generateId(),
							action: 'registered',
							notes: 'Auto-created from QA/QC release',
							performedBy,
							performedAt: now
						}
					}
				},
				{ upsert: true }
			);
		}

		return { success: true };
	}
};
