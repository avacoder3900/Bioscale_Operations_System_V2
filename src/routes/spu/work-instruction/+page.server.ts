import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB } from '$lib/server/db';
import {
	getSpuWorkInstructionDoc,
	createSpuWiDraftVersion
} from '$lib/server/services/spu-work-instruction';
import { parseSpuWorkInstruction, PARSER_VERSION } from '$lib/server/services/spu-wi-parser';
import type { Actions, PageServerLoad } from './$types';

const MAX_BYTES = 25 * 1024 * 1024;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const wi: any = await getSpuWorkInstructionDoc();

	const activeVersion = wi
		? (wi.versions ?? []).find((v: any) => v.version === wi.currentVersion)
		: null;

	const draftVersions = wi
		? (wi.versions ?? [])
				.filter((v: any) => v.version !== wi.currentVersion)
				.map((v: any) => ({
					id: v._id,
					version: v.version,
					parsedAt: v.parsedAt,
					stepCount: (v.steps ?? []).length,
					discarded: typeof v.changeNotes === 'string' && v.changeNotes.startsWith('discarded')
				}))
		: [];

	return {
		wi: wi
			? {
					id: wi._id,
					title: wi.title,
					revision: wi.revision ?? '',
					status: wi.status,
					currentVersion: wi.currentVersion ?? 0,
					effectiveDate: wi.effectiveDate ?? null,
					originalFileName: wi.originalFileName ?? null
				}
			: null,
		activeVersion: activeVersion
			? JSON.parse(
					JSON.stringify({
						id: (activeVersion as any)._id,
						version: (activeVersion as any).version,
						stepCount: ((activeVersion as any).steps ?? []).length,
						barcodeFieldCount: ((activeVersion as any).steps ?? []).reduce(
							(n: number, s: any) => n + (s.fieldDefinitions ?? []).length,
							0
						)
					})
				)
			: null,
		draftVersions,
		parserVersion: PARSER_VERSION
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const file = form.get('file');

		if (!(file instanceof File) || file.size === 0) {
			return fail(400, { error: 'No file provided' });
		}
		if (file.size > MAX_BYTES) {
			return fail(400, { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)` });
		}

		const name = file.name || 'work-instruction';
		const lower = name.toLowerCase();
		if (!lower.endsWith('.docx') && !lower.endsWith('.pdf')) {
			return fail(400, { error: 'Only .docx and .pdf files are supported' });
		}

		const buffer = Buffer.from(await file.arrayBuffer());

		const fallbackMime = lower.endsWith('.pdf')
			? 'application/pdf'
			: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

		let parsed;
		try {
			parsed = await parseSpuWorkInstruction({
				buffer,
				mimeType: file.type || fallbackMime,
				originalName: name
			});
		} catch (err: any) {
			return fail(400, { error: `Parse failed: ${err?.message ?? 'unknown error'}` });
		}

		if (!parsed.steps?.length) {
			return fail(400, { error: 'Parser produced no steps from this document' });
		}

		const { workInstructionId, versionId } = await createSpuWiDraftVersion({
			title: parsed.title,
			originalFileName: name,
			fileSize: file.size,
			mimeType: file.type,
			rawContent: parsed.rawContent,
			parsedSteps: parsed.steps,
			parserVersion: parsed.parserVersion,
			preparedBy: locals.user!.username
		});

		redirect(303, `/spu/work-instruction/review/${versionId}?wi=${workInstructionId}`);
	}
};

export const config = { maxDuration: 120 };
