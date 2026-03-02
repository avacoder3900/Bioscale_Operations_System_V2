import { redirect } from '@sveltejs/kit';
import { connectDB, Consumable } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const rolls = await Consumable.find({ type: 'top_seal_roll' }).sort({ createdAt: -1 }).lean();

	return {
		sessions: rolls.map((r: any) => ({
			id: r._id,
			status: (r.remainingLengthFt ?? 0) > 0 ? 'active' : 'depleted',
			startedAt: r.createdAt,
			completedAt: null,
			operatorName: r.registeredBy ?? null,
			cartridgeCount: r.usageLog?.length ?? 0,
			barcode: r.barcode ?? null,
			initialLengthFt: r.initialLengthFt ?? null,
			remainingLengthFt: r.remainingLengthFt ?? null
		}))
	};
};

export const actions: Actions = {
	registerRoll: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		await Consumable.create({
			type: 'top_seal_roll',
			barcode: data.get('barcode') as string,
			initialLengthFt: Number(data.get('initialLengthFt') || 0),
			remainingLengthFt: Number(data.get('initialLengthFt') || 0),
			status: 'active',
			registeredBy: locals.user._id,
			usageLog: []
		});
		return { success: true };
	},

	recordUsage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const rollId = data.get('rollId') as string;
		const lengthUsed = Number(data.get('lengthUsed') || 0);

		const roll = await Consumable.findById(rollId).lean() as any;
		if (!roll) return { error: 'Roll not found' };

		const remainingBefore = roll.remainingLengthFt ?? 0;
		const remainingAfter = Math.max(0, remainingBefore - lengthUsed);

		await Consumable.findByIdAndUpdate(rollId, {
			$set: { remainingLengthFt: remainingAfter },
			$push: {
				usageLog: {
					usageType: 'cut',
					quantityChanged: -lengthUsed,
					remainingBefore,
					remainingAfter,
					operator: { _id: locals.user._id, username: locals.user.username },
					createdAt: new Date()
				}
			}
		});
		return { success: true };
	}
};
