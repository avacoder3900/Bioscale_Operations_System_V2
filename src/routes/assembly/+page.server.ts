import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssemblySession, Spu, User, generateId, AuditLog } from '$lib/server/db';
import { generateNextSpuUdi } from '$lib/server/services/udi-generator';
import { getActiveSpuWorkInstruction } from '$lib/server/services/spu-work-instruction';
import type { Actions, PageServerLoad } from './$types';

const STALE_DRAFT_MS = 24 * 60 * 60 * 1000;

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

	const activeWi = await getActiveSpuWorkInstruction();

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
		})),
		activeWorkInstruction: activeWi
			? {
					id: (activeWi as any)._id,
					title: (activeWi as any).title,
					revision: (activeWi as any).revision ?? '',
					currentVersion: (activeWi as any).currentVersion ?? 1,
					effectiveDate: (activeWi as any).effectiveDate ?? null
				}
			: null
	};
};

export const actions: Actions = {
	startNewBuild: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const buildRunId = form.get('buildRunId')?.toString() || undefined;

		const recentDraft = await Spu.findOne({
			createdBy: locals.user!._id,
			status: 'draft',
			assemblyStatus: 'created',
			createdAt: { $gte: new Date(Date.now() - STALE_DRAFT_MS) }
		}).lean();

		let spuId: string;
		let udi: string;

		if (recentDraft) {
			spuId = (recentDraft as any)._id;
			udi = (recentDraft as any).udi;
		} else {
			udi = await generateNextSpuUdi({
				_id: locals.user!._id,
				username: locals.user!.username
			});
			spuId = generateId();

			const now = new Date();
			await Spu.create({
				_id: spuId,
				udi,
				status: 'draft',
				assemblyStatus: 'created',
				statusTransitions: [
					{
						_id: generateId(),
						from: null,
						to: 'draft',
						changedBy: { _id: locals.user!._id, username: locals.user!.username },
						changedAt: now,
						reason: 'auto_created_assembly_tab'
					}
				],
				createdBy: locals.user!._id
			});

			if (buildRunId) {
				await Spu.updateOne({ _id: spuId }, { $set: { 'batch._id': buildRunId } });
			}

			await AuditLog.create({
				_id: generateId(),
				tableName: 'spus',
				recordId: spuId,
				action: 'INSERT',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: now,
				newData: { event: 'auto_create_draft', udi, buildRunId: buildRunId ?? null }
			});
		}

		const activeWi = await getActiveSpuWorkInstruction();

		return {
			startedBuild: {
				spuId,
				udi,
				resumed: !!recentDraft,
				workInstruction: activeWi
					? {
							id: (activeWi as any)._id,
							title: (activeWi as any).title,
							revision: (activeWi as any).revision ?? '',
							currentVersion: (activeWi as any).currentVersion ?? 1
						}
					: null
			}
		};
	},

	openWorkInstruction: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString();
		if (!spuId) return fail(400, { error: 'SPU ID required' });

		const spu = await Spu.findById(spuId);
		if (!spu) return fail(400, { error: 'SPU not found' });

		const activeWi = await getActiveSpuWorkInstruction();
		if (!activeWi) return fail(400, { error: 'No active SPU work instruction. Upload one first.' });

		const sessionId = generateId();
		await AssemblySession.create({
			_id: sessionId,
			spuId,
			userId: locals.user!._id,
			status: 'in_progress',
			startedAt: new Date(),
			currentStepIndex: 0,
			workInstructionId: (activeWi as any)._id,
			workInstructionTitle: (activeWi as any).title,
			stepRecords: []
		});

		await Spu.updateOne(
			{ _id: spuId },
			{
				$set: { status: 'assembling', assemblyStatus: 'in_progress' },
				$push: {
					statusTransitions: {
						_id: generateId(),
						from: spu.status ?? 'draft',
						to: 'assembling',
						changedBy: { _id: locals.user!._id, username: locals.user!.username },
						changedAt: new Date(),
						reason: 'wi_widget_continue'
					}
				}
			}
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: sessionId,
			action: 'INSERT',
			changedBy: locals.user?.username ?? locals.user?._id,
			changedAt: new Date()
		});

		redirect(303, `/assembly/${sessionId}`);
	}
};

export const config = { maxDuration: 60 };
