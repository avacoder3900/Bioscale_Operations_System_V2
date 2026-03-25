import { error, fail, redirect } from '@sveltejs/kit';
import { connectDB, WorkInstruction, ProductionRun, User, PartDefinition, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	await connectDB();
	const wi = await WorkInstruction.findById(params.id).lean() as any;
	if (!wi) error(404, 'Work instruction not found');

	// Get the current version
	const currentVersion = (wi.versions ?? []).find(
		(v: any) => v.version === wi.currentVersion
	) ?? (wi.versions ?? []).slice(-1)[0];

	// Get production runs linked to this work instruction
	const runs = await ProductionRun.find({ workInstructionId: params.id })
		.sort({ createdAt: -1 }).limit(50).lean() as any[];

	const builderIds = [...new Set(runs.map((r: any) => r.leadBuilder?._id).filter(Boolean))];
	const builders = builderIds.length > 0
		? await User.find({ _id: { $in: builderIds } }).select('_id username').lean()
		: [];
	const builderMap = new Map((builders as any[]).map((u: any) => [String(u._id), u.username]));

	// Load available parts for inventory linking
	const parts = await PartDefinition.find({ isActive: true })
		.select('_id name partNumber').limit(200).lean() as any[];

	const isAdmin = locals.user?.roles?.includes('admin') ?? false;
	const canEdit = isAdmin || (locals.user?.roles?.includes('operator') ?? false);

	// Active runs with unit details
	const activeRuns = runs
		.filter((r: any) => ['planning', 'in_progress', 'paused'].includes(r.status ?? ''))
		.map((r: any) => ({
			id: String(r._id),
			runNumber: r.runNumber ?? '',
			status: r.status ?? 'planning',
			quantity: r.quantity ?? 0,
			startedAt: r.startedAt ?? null,
			createdAt: r.createdAt ?? new Date(),
			completedCount: (r.units ?? []).filter((u: any) => u.status === 'completed').length,
			units: (r.units ?? []).map((u: any) => ({
				unitId: String(u._id),
				unitIndex: u.unitIndex ?? 0,
				unitStatus: u.status ?? 'pending',
				spuId: u.spuId ?? '',
				udi: u.spuId ?? '',
				startedAt: u.startedAt ?? null,
				completedAt: u.completedAt ?? null
			}))
		}));

	// Version history
	const versionHistory = (wi.versions ?? []).map((v: any) => ({
		id: String(v._id),
		version: v.version ?? 0,
		changeNotes: v.changeNotes ?? null,
		parsedAt: v.parsedAt ?? null,
		createdAt: v.createdAt ?? new Date()
	}));

	// Steps from current version
	const steps = (currentVersion?.steps ?? []).map((s: any) => ({
		id: String(s._id),
		stepNumber: s.stepNumber ?? 0,
		title: s.title ?? '',
		content: s.content ?? null,
		imageData: s.imageData ?? null,
		imageContentType: s.imageContentType ?? null,
		requiresScan: s.requiresScan ?? false,
		scanPrompt: s.scanPrompt ?? null,
		notes: s.notes ?? null,
		partRequirements: (s.partRequirements ?? []).map((pr: any) => ({
			id: String(pr._id),
			partNumber: pr.partNumber ?? '',
			quantity: pr.quantity ?? 1,
			notes: pr.notes ?? null,
			partDefinitionId: pr.partDefinitionId ?? null,
			partName: null,
			partCategory: null,
			partSupplier: null,
			unitCost: null
		})),
		toolRequirements: (s.toolRequirements ?? []).map((tr: any) => ({
			id: String(tr._id),
			toolNumber: tr.toolNumber ?? '',
			toolName: tr.toolName ?? null,
			calibrationRequired: tr.calibrationRequired ?? false,
			notes: tr.notes ?? null
		})),
		fieldCount: (s.fieldDefinitions ?? []).length,
		partDefinitionId: s.partDefinitionId ?? null,
		partQuantity: s.partQuantity ?? 1
	}));

	return {
		workInstruction: {
			documentNumber: wi.documentNumber ?? '',
			title: wi.title ?? '',
			description: wi.description ?? null,
			documentType: wi.documentType ?? 'work_instruction',
			status: wi.status ?? 'draft',
			currentVersion: wi.currentVersion ?? 1,
			originalFileName: wi.originalFileName ?? null,
			fileSize: wi.fileSize ?? null,
			createdAt: wi.createdAt ?? new Date(),
			updatedAt: wi.updatedAt ?? new Date(),
			creatorName: wi.createdBy ?? null
		},
		currentVersion: currentVersion ? {
			id: String(currentVersion._id),
			version: currentVersion.version ?? 1,
			content: currentVersion.content ?? null,
			changeNotes: currentVersion.changeNotes ?? null,
			parsedAt: currentVersion.parsedAt ?? null,
			parsedByName: currentVersion.parsedBy ?? null
		} : null,
		steps,
		versionHistory,
		availableParts: parts.map((p: any) => ({
			id: String(p._id),
			name: p.name ?? '',
			partNumber: p.partNumber ?? null
		})),
		canEdit,
		isAdmin,
		activeRuns
	};
};

export const actions: Actions = {
	changeStatus: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const status = data.get('status') as string;
			if (!status) return fail(400, { error: 'Status required' });

			const allowed = ['draft', 'active', 'archived'];
			if (!allowed.includes(status)) return fail(400, { error: 'Invalid status' });

			await WorkInstruction.findByIdAndUpdate(params.id, { $set: { status } });
			return { success: true, statusChanged: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to change status' });
		}
	},

	createRun: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const quantity = Number(data.get('quantity') || 1);

			if (quantity < 1) return fail(400, { error: 'Quantity must be at least 1' });

			const wi = await WorkInstruction.findById(params.id).lean() as any;
			if (!wi) return fail(404, { error: 'Work instruction not found' });
			if (wi.status !== 'active') return fail(400, { error: 'Work instruction must be active to create a run' });

			const now = new Date();
			const dateStr = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
			const seq = await ProductionRun.countDocuments({
				createdAt: { $gte: new Date(now.getFullYear(), now.getMonth(), now.getDate()) }
			});
			const runNumber = `RUN-${dateStr}-${String(seq + 1).padStart(3, '0')}`;

			const units = Array.from({ length: quantity }, (_, i) => ({
				_id: generateId(),
				unitIndex: i + 1,
				status: 'pending',
				spuId: '',
				startedAt: null,
				completedAt: null
			}));

			const runId = generateId();
			await ProductionRun.create({
				_id: runId,
				workInstructionId: params.id,
				workInstructionVersionId: wi.versions?.find((v: any) => v.version === wi.currentVersion)?._id ?? null,
				quantity,
				status: 'planning',
				runNumber,
				leadBuilder: locals.user ? { _id: locals.user._id, username: locals.user.username } : undefined,
				units
			});

			return { success: true, runId, workInstructionId: params.id };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to create run' });
		}
	},

	bulkCancelRuns: async ({ request, params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		try {
			const data = await request.formData();
			const runIdsRaw = data.get('runIds') as string;
			const reason = (data.get('reason') as string)?.trim() || 'Bulk cancelled';

			let runIds: string[];
			try {
				runIds = JSON.parse(runIdsRaw || '[]');
			} catch {
				return fail(400, { error: 'Invalid run IDs' });
			}

			if (!runIds.length) return fail(400, { error: 'No runs selected' });

			const runs = await ProductionRun.find({
				_id: { $in: runIds },
				workInstructionId: params.id,
				status: { $in: ['planning', 'in_progress', 'paused'] }
			}).lean() as any[];

			let totalUnits = 0;
			let totalRetracted = 0;

			for (const run of runs) {
				totalUnits += run.quantity ?? 0;
				const pendingUnits = (run.units ?? []).filter((u: any) => u.status !== 'completed').length;
				totalRetracted += pendingUnits;

				await ProductionRun.findByIdAndUpdate(run._id, {
					$set: {
						status: 'completed',
						completedAt: new Date(),
						cancellationReason: reason,
						cancelledBy: locals.user ? { _id: locals.user._id, username: locals.user.username } : undefined
					}
				});
			}

			return {
				success: true,
				bulkCancelled: true,
				cancelledRuns: runs.length,
				totalRetracted,
				totalUnits
			};
		} catch (err: any) {
			return fail(500, { bulkCancelError: err.message ?? 'Failed to cancel runs' });
		}
	}
};

export const config = { maxDuration: 60 };
