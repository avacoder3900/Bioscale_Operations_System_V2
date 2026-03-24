import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssemblySession, Spu, WorkInstruction, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessions = await AssemblySession.find()
		.sort({ createdAt: -1 })
		.limit(50)
		.lean();

	const userIds = [...new Set(sessions.map((s: any) => s.userId).filter(Boolean))];
	const users = userIds.length ? await User.find({ _id: { $in: userIds } }, { username: 1 }).lean() : [];
	const userMap = new Map(users.map((u: any) => [u._id, u.username]));

	return {
		sessions: sessions.map((s: any) => ({
			id: s._id,
			spuId: s.spuId ?? '',
			status: s.status ?? 'in_progress',
			startedAt: s.startedAt ?? s.createdAt,
			completedAt: s.completedAt ?? null,
			operatorId: s.userId ?? '',
			operatorName: userMap.get(s.userId) ?? '',
			workInstructionTitle: s.workInstructionTitle ?? '',
			currentStepIndex: s.currentStepIndex ?? 0,
			totalSteps: (s.stepRecords ?? []).length
		}))
	};
};

export const actions: Actions = {
	start: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		if (!spuId) return fail(400, { error: 'SPU ID required' });

		const spu = await Spu.findById(spuId);
		if (!spu) return fail(400, { error: 'SPU not found' });

		const sessionId = generateId();
		await AssemblySession.create({
			_id: sessionId,
			spuId,
			userId: locals.user!._id,
			status: 'in_progress',
			startedAt: new Date(),
			currentStepIndex: 0,
			workInstructionId: form.get('workInstructionId')?.toString() || undefined,
			workInstructionTitle: form.get('workInstructionTitle')?.toString() || undefined,
			stepRecords: []
		});

		await Spu.updateOne({ _id: spuId }, {
			$set: { status: 'assembling', assemblyStatus: 'in_progress' }
		});

		redirect(303, `/spu/assembly/${sessionId}`);
	}
};
