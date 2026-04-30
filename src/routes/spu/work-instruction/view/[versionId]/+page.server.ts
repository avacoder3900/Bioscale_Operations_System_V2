import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, WorkInstruction } from '$lib/server/db';
import {
	getSpuWorkInstructionDoc,
	findVersion
} from '$lib/server/services/spu-work-instruction';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const versionId = params.versionId;
	const wiId = url.searchParams.get('wi');

	const wi: any = wiId
		? await WorkInstruction.findById(wiId).lean()
		: await getSpuWorkInstructionDoc().then((d) => (d ? d.toObject() : null));
	if (!wi) throw error(404, 'Work instruction not found');

	const version = findVersion(wi, versionId);
	if (!version) throw error(404, 'Version not found');

	const isActive = wi.currentVersion === version.version && wi.status === 'active';

	const totalScans = (version.parts ?? []).reduce(
		(n: number, p: any) => n + (p.fieldDefinitions ?? []).length,
		0
	);

	return {
		wiId: wi._id,
		wiTitle: wi.title,
		isActive,
		version: JSON.parse(
			JSON.stringify({
				id: version._id,
				version: version.version,
				parsedAt: version.parsedAt,
				renderedHtml: version.renderedHtml ?? '',
				parts: version.parts ?? [],
				originalFileName: version.parsedBy ? wi.originalFileName : null
			})
		),
		summary: {
			partCount: (version.parts ?? []).length,
			totalScans
		}
	};
};

export const config = { maxDuration: 30 };
