import { error } from '@sveltejs/kit';
import { connectDB, WorkInstruction, ProductionRun, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const wi = await WorkInstruction.findById(params.id).lean() as any;
	if (!wi) error(404, 'Work instruction not found');

	// Get the current version
	const currentVersion = (wi.versions ?? []).find(
		(v: any) => v.version === wi.currentVersion
	) ?? (wi.versions ?? []).slice(-1)[0];

	// Get production runs linked to this work instruction
	const runs = await ProductionRun.find({ workInstructionId: params.id })
		.sort({ createdAt: -1 }).limit(50).lean();

	const builderIds = [...new Set(runs.map((r: any) => r.leadBuilder?._id).filter(Boolean))];
	const builders = builderIds.length > 0
		? await User.find({ _id: { $in: builderIds } }).select('_id username').lean()
		: [];
	const builderMap = new Map(builders.map((u: any) => [u._id, u.username]));

	return {
		instruction: {
			id: wi._id,
			title: wi.title ?? '',
			documentNumber: wi.documentNumber ?? '',
			version: wi.currentVersion ?? 1,
			status: wi.status ?? 'draft',
			category: wi.category ?? null,
			content: currentVersion?.content ?? null,
			steps: (currentVersion?.steps ?? []).map((s: any) => ({
				id: s._id,
				stepNumber: s.stepNumber ?? 0,
				title: s.title ?? '',
				description: s.content ?? '',
				fields: (s.fieldDefinitions ?? []).map((f: any) => ({
					id: f._id,
					fieldName: f.fieldName ?? '',
					fieldLabel: f.fieldLabel ?? '',
					fieldType: f.fieldType ?? 'manual_entry',
					isRequired: f.isRequired ?? false,
					options: f.options ?? null
				}))
			})),
			createdAt: wi.createdAt,
			updatedAt: wi.updatedAt
		},
		runs: runs.map((r: any) => ({
			id: r._id,
			runNumber: r.runNumber ?? '',
			status: r.status ?? 'planning',
			startedAt: r.startedAt ?? r.createdAt,
			completedAt: r.completedAt ?? null,
			operatorName: r.leadBuilder?._id ? (builderMap.get(r.leadBuilder._id) ?? r.leadBuilder.username ?? 'Unknown') : 'Unknown'
		}))
	};
};
