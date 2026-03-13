import { error } from '@sveltejs/kit';
import { connectDB, WorkInstruction } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	await connectDB();
	const wi = await WorkInstruction.findById(params.id).lean() as any;
	if (!wi) error(404, 'Work instruction not found');

	const currentVersion = (wi.versions ?? []).find(
		(v: any) => v.version === wi.currentVersion
	) ?? (wi.versions ?? []).slice(-1)[0];

	const fields: any[] = [];
	for (const step of currentVersion?.steps ?? []) {
		for (const fd of step.fieldDefinitions ?? []) {
			fields.push({
				id: fd._id,
				stepId: step._id,
				fieldName: fd.fieldName ?? '',
				fieldType: fd.fieldType ?? 'manual_entry',
				isRequired: fd.isRequired ?? false,
				options: fd.options ?? null,
				defaultValue: null
			});
		}
	}

	return {
		instruction: { id: wi._id, title: wi.title ?? '' },
		fields
	};
};
