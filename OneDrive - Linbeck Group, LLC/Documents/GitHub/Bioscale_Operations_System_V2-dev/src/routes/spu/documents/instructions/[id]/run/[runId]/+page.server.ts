import { error, fail } from '@sveltejs/kit';
import { connectDB, WorkInstruction, ProductionRun, User, AssemblySession } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'workInstruction:read');
	await connectDB();

	const [wi, run] = await Promise.all([
		WorkInstruction.findById(params.id).lean() as any,
		ProductionRun.findById(params.runId).lean() as any
	]);
	if (!wi) error(404, 'Work instruction not found');
	if (!run) error(404, 'Production run not found');

	const currentVersion = (wi.versions ?? []).find(
		(v: any) => v.version === wi.currentVersion
	) ?? (wi.versions ?? []).slice(-1)[0];

	let leadBuilderName = 'Unknown';
	if (run.leadBuilder?._id) {
		const user = await User.findById(run.leadBuilder._id).select('username').lean() as any;
		leadBuilderName = user?.username ?? run.leadBuilder.username ?? 'Unknown';
	} else if (run.leadBuilder?.username) {
		leadBuilderName = run.leadBuilder.username;
	}

	// Build step list from WI version
	const steps = (currentVersion?.steps ?? []).map((s: any) => ({
		id: s._id,
		stepNumber: s.stepNumber ?? 0,
		title: s.title ?? '',
		description: s.content ?? s.description ?? '',
		requiresScan: s.requiresScan ?? false,
		scanPrompt: s.scanPrompt ?? null,
		partRequirements: (s.partRequirements ?? []).map((pr: any) => ({
			id: pr._id,
			partNumber: pr.partNumber ?? '',
			quantity: pr.quantity ?? 1
		})),
		fields: (s.fieldDefinitions ?? []).map((f: any) => ({
			id: f._id,
			fieldName: f.fieldName ?? '',
			fieldLabel: f.fieldLabel ?? f.fieldName ?? '',
			fieldType: f.fieldType ?? 'manual_entry',
			isRequired: f.isRequired ?? false
		}))
	}));

	// Get completed steps by assembly session
	const unitAssemblySessionIds = (run.units ?? [])
		.map((u: any) => u.assemblySessionId)
		.filter(Boolean);

	const assemblySessions = unitAssemblySessionIds.length
		? await AssemblySession.find(
				{ _id: { $in: unitAssemblySessionIds } },
				{ _id: 1, stepRecords: 1 }
			).lean()
		: [];

	const completedStepsBySession: Record<string, string[]> = {};
	for (const session of assemblySessions as any[]) {
		const completedStepIds = (session.stepRecords ?? [])
			.filter((sr: any) => sr.completedAt)
			.map((sr: any) => sr.workInstructionStepId)
			.filter(Boolean);
		completedStepsBySession[session._id] = completedStepIds;
	}

	// Progress calculation
	const totalUnits = run.units?.length ?? 0;
	const completedUnits = (run.units ?? []).filter((u: any) => u.status === 'completed').length;
	const progress = {
		completedUnits,
		totalUnits,
		percent: totalUnits > 0 ? Math.round((completedUnits / totalUnits) * 100) : 0
	};

	return {
		workInstructionTitle: wi.title ?? '',
		leadBuilderName,
		steps,
		progress,
		completedStepsBySession,
		run: {
			id: run._id,
			runNumber: run.runNumber ?? '',
			status: run.status ?? 'planning',
			workInstructionId: run.workInstructionId ?? params.id,
			quantity: run.quantity ?? 0,
			startedAt: run.startedAt ?? run.createdAt,
			completedAt: run.completedAt ?? null
		},
		units: (run.units ?? []).map((u: any) => ({
			id: u._id,
			unitNumber: u.unitIndex ?? 0,
			spuId: u.spuId ?? null,
			assemblySessionId: u.assemblySessionId ?? null,
			status: u.status ?? 'pending',
			startedAt: u.startedAt ?? null,
			completedAt: u.completedAt ?? null
		}))
	};
};

export const actions: Actions = {
	signUnit: async ({ request, params }) => {
		await connectDB();
		const form = await request.formData();
		const unitId = form.get('unitId')?.toString();
		if (!unitId) return fail(400, { error: 'Unit ID required' });

		await ProductionRun.updateOne(
			{ _id: params.runId, 'units._id': unitId },
			{
				$set: {
					'units.$.status': 'completed',
					'units.$.completedAt': new Date()
				}
			}
		);
		return { success: true };
	},

	completeRun: async ({ params }) => {
		await connectDB();
		await ProductionRun.updateOne({ _id: params.runId }, {
			$set: { status: 'completed', completedAt: new Date() }
		});
		return { success: true };
	},

	cancelRun: async ({ params }) => {
		await connectDB();
		await ProductionRun.updateOne({ _id: params.runId }, {
			$set: { status: 'planning' }
		});
		return { success: true };
	}
};
