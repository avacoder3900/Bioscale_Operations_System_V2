import { error, fail, redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { connectDB, WorkInstruction } from '$lib/server/db';
import {
	getSpuWorkInstructionDoc,
	findVersion,
	inductSpuWiVersion,
	rejectSpuWiVersion
} from '$lib/server/services/spu-work-instruction';
import type { Actions, PageServerLoad } from './$types';

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
	const canApprove = hasPermission(locals.user, 'spu:write');

	const totalScans = (version.parts ?? []).reduce(
		(n: number, p: any) => n + (p.fieldDefinitions ?? []).length,
		0
	);

	return {
		wiId: wi._id,
		wiTitle: wi.title,
		isActive,
		canApprove,
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

export const actions: Actions = {
	induct: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const versionId = params.versionId;
		const form = await request.formData();
		const wiId = form.get('wiId')?.toString();
		if (!wiId) return fail(400, { error: 'Missing wiId' });

		try {
			await inductSpuWiVersion(wiId, versionId, {
				_id: locals.user!._id,
				username: locals.user!.username
			});
		} catch (err: any) {
			return fail(400, { error: err?.message ?? 'Induct failed' });
		}

		redirect(303, '/spu/work-instruction');
	},

	reject: async ({ request, locals, params }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const versionId = params.versionId;
		const form = await request.formData();
		const wiId = form.get('wiId')?.toString();
		if (!wiId) return fail(400, { error: 'Missing wiId' });

		await rejectSpuWiVersion(wiId, versionId, {
			_id: locals.user!._id,
			username: locals.user!.username
		});

		redirect(303, '/spu/work-instruction');
	}
};

export const config = { maxDuration: 30 };
