/**
 * SPU Manufacturing dashboard — PRD-SPU-MFG-UNIFIED §4.1, Story SPU-MFG-02.
 *
 * Load function returns the set of in-flight AssemblySessions joined with their
 * SPU (for UDI) and operator (for username), the list of active WorkInstructions
 * available to start a new build with, a preview of the next UDI that would be
 * assigned, and two permission flags controlling whether the operator sees the
 * "Start New Build" panel and the "Upload Work Instruction" link.
 *
 * The `startNewBuild` action generates a fresh UDI via the atomic `getNextUdi()`
 * utility (SPU-MFG-01), creates a draft SPU in the `assembling` state, creates
 * an AssemblySession pointing at it, writes AuditLog entries for both documents,
 * and redirects to the existing `/assembly/[sessionId]` build page.
 */
import { fail, redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import {
	connectDB,
	AssemblySession,
	Spu,
	WorkInstruction,
	User,
	AuditLog,
	generateId
} from '$lib/server/db';
import { getNextUdi, peekNextUdi } from '$lib/server/db/udi-generator';
import type { Actions, PageServerLoad } from './$types';

interface InFlightBuild {
	sessionId: string;
	spuId: string;
	udi: string;
	status: 'in_progress' | 'paused';
	currentStepIndex: number;
	currentStepTitle: string;
	totalSteps: number;
	operatorUsername: string;
	startedAt: string | null;
	workInstructionTitle: string;
	percentComplete: number;
}

interface ActiveWorkInstructionOption {
	_id: string;
	documentNumber: string;
	title: string;
	currentVersion: number | null;
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessions = await AssemblySession.find({ status: { $in: ['in_progress', 'paused'] } })
		.sort({ startedAt: -1 })
		.limit(100)
		.lean();

	const spuIds = [...new Set(sessions.map((s: any) => s.spuId).filter(Boolean))];
	const userIds = [...new Set(sessions.map((s: any) => s.userId).filter(Boolean))];
	const wiIds = [...new Set(sessions.map((s: any) => s.workInstructionId).filter(Boolean))];

	const [spus, users, wis] = await Promise.all([
		spuIds.length
			? Spu.find({ _id: { $in: spuIds } }, { udi: 1 }).lean()
			: Promise.resolve([] as any[]),
		userIds.length
			? User.find({ _id: { $in: userIds } }, { username: 1 }).lean()
			: Promise.resolve([] as any[]),
		wiIds.length
			? WorkInstruction.find(
					{ _id: { $in: wiIds } },
					{ title: 1, documentNumber: 1, currentVersion: 1, versions: 1 }
			  ).lean()
			: Promise.resolve([] as any[])
	]);

	const spuMap = new Map(spus.map((s: any) => [s._id, s.udi ?? '']));
	const userMap = new Map(users.map((u: any) => [u._id, u.username ?? '']));

	// Map work-instruction id → total step count for the version the session was
	// started against (falls back to `currentVersion` if the session did not
	// persist its own version, falls back to 0 otherwise).
	const wiStepCountMap = new Map<string, { totalSteps: number }>();
	for (const wi of wis as any[]) {
		wiStepCountMap.set(wi._id, { totalSteps: 0 });
	}

	const inFlightBuilds: InFlightBuild[] = sessions.map((s: any) => {
		const wi = (wis as any[]).find((w) => w._id === s.workInstructionId);
		const versionNum = s.workInstructionVersion ?? wi?.currentVersion ?? null;
		const version = wi?.versions?.find((v: any) => v.version === versionNum) ?? wi?.versions?.[0];
		const totalSteps: number = version?.steps?.length ?? (s.stepRecords?.length ?? 0);
		const currentStepIndex: number = s.currentStepIndex ?? 0;
		const currentStepTitle: string =
			version?.steps?.[currentStepIndex]?.title ?? `Step ${currentStepIndex + 1}`;
		const percentComplete =
			totalSteps > 0 ? Math.round((currentStepIndex / totalSteps) * 100) : 0;

		return {
			sessionId: s._id,
			spuId: s.spuId ?? '',
			udi: spuMap.get(s.spuId) ?? '',
			status: s.status,
			currentStepIndex,
			currentStepTitle,
			totalSteps,
			operatorUsername: userMap.get(s.userId) ?? '',
			startedAt: s.startedAt ? new Date(s.startedAt).toISOString() : null,
			workInstructionTitle: s.workInstructionTitle ?? wi?.title ?? '',
			percentComplete
		};
	});

	const activeWIsRaw = await WorkInstruction.find({ status: 'active' })
		.select('_id documentNumber title currentVersion')
		.sort({ documentNumber: 1 })
		.lean();

	const activeWorkInstructions: ActiveWorkInstructionOption[] = (activeWIsRaw as any[]).map(
		(w) => ({
			_id: w._id,
			documentNumber: w.documentNumber ?? '',
			title: w.title ?? '',
			currentVersion: w.currentVersion ?? null
		})
	);

	const nextUdiPreview = await peekNextUdi();

	return JSON.parse(
		JSON.stringify({
			inFlightBuilds,
			activeWorkInstructions,
			nextUdiPreview,
			canStartNew: hasPermission(locals.user, 'spu:write'),
			canUploadWI:
				hasPermission(locals.user, 'admin:full') ||
				hasPermission(locals.user, 'workInstruction:write')
		})
	);
};

export const actions: Actions = {
	startNewBuild: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const workInstructionId = form.get('workInstructionId')?.toString();
		if (!workInstructionId) {
			return fail(400, { error: 'Work instruction is required' });
		}

		const wi = await WorkInstruction.findById(workInstructionId)
			.select('_id title currentVersion status')
			.lean<{ _id: string; title?: string; currentVersion?: number; status?: string } | null>();
		if (!wi) {
			return fail(400, { error: 'Work instruction not found' });
		}

		const { udi } = await getNextUdi();

		const spuId = generateId();
		const sessionId = generateId();
		const now = new Date();

		await Spu.create({
			_id: spuId,
			udi,
			status: 'assembling',
			assemblyStatus: 'in_progress',
			createdBy: locals.user!._id
		});

		await AssemblySession.create({
			_id: sessionId,
			spuId,
			userId: locals.user!._id,
			status: 'in_progress',
			startedAt: now,
			currentStepIndex: 0,
			workInstructionId: wi._id,
			workInstructionTitle: wi.title ?? '',
			workInstructionVersion: wi.currentVersion ?? undefined,
			stepRecords: [],
			createdAt: now
		});

		const auditChangedBy = locals.user?.username ?? locals.user?._id;
		await AuditLog.create({
			_id: generateId(),
			tableName: 'spus',
			recordId: spuId,
			action: 'INSERT',
			changedBy: auditChangedBy,
			changedAt: now,
			newData: { udi, status: 'assembling', assemblyStatus: 'in_progress' }
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'assembly_sessions',
			recordId: sessionId,
			action: 'INSERT',
			changedBy: auditChangedBy,
			changedAt: now,
			newData: {
				spuId,
				workInstructionId: wi._id,
				workInstructionTitle: wi.title ?? '',
				workInstructionVersion: wi.currentVersion ?? null
			}
		});

		throw redirect(303, `/assembly/${sessionId}`);
	}
};
