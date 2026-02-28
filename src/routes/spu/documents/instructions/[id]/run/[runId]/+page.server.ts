import { error } from '@sveltejs/kit';
import { connectDB, WorkInstruction, ProductionRun, User } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
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

	let operatorName = 'Unknown';
	if (run.leadBuilder?._id) {
		const user = await User.findById(run.leadBuilder._id).select('username').lean() as any;
		operatorName = user?.username ?? run.leadBuilder.username ?? 'Unknown';
	}

	return {
		instruction: {
			id: wi._id,
			title: wi.title ?? '',
			steps: (currentVersion?.steps ?? []).map((s: any) => ({
				id: s._id,
				stepNumber: s.stepNumber ?? 0,
				title: s.title ?? '',
				description: s.content ?? '',
				fields: (s.fieldDefinitions ?? []).map((f: any) => ({
					id: f._id,
					fieldName: f.fieldName ?? '',
					fieldType: f.fieldType ?? 'manual_entry',
					isRequired: f.isRequired ?? false
				}))
			}))
		},
		run: {
			id: run._id,
			runNumber: run.runNumber ?? '',
			status: run.status ?? 'planning',
			startedAt: run.startedAt ?? run.createdAt,
			completedAt: run.completedAt ?? null,
			quantity: run.quantity ?? 0,
			operatorName,
			units: (run.units ?? []).map((u: any) => ({
				id: u._id,
				unitNumber: u.unitIndex ?? 0,
				status: u.status ?? 'pending',
				stepData: {}
			}))
		}
	};
};
