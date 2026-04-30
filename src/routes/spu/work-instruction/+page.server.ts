import { fail } from '@sveltejs/kit';
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
		const audit: Record<string, unknown> = {
			startedAt: new Date().toISOString(),
			parserVersion: PARSER_VERSION
		};

		try {
			console.log('[wi-upload] action invoked');
			requirePermission(locals.user, 'spu:write');
			audit.user = locals.user?.username ?? 'unknown';

			await connectDB();
			audit.dbConnected = true;

			const form = await request.formData();
			const file = form.get('file');
			audit.fileFieldType = file?.constructor?.name ?? typeof file;

			if (!(file instanceof File) || file.size === 0) {
				audit.failure = 'no-file';
				console.log('[wi-upload] no file', audit);
				return fail(400, { error: 'No file provided', audit });
			}

			audit.fileName = file.name;
			audit.fileSize = file.size;
			audit.mimeTypeFromBrowser = file.type;

			if (file.size > MAX_BYTES) {
				audit.failure = 'too-large';
				return fail(400, { error: `File too large (max ${MAX_BYTES / 1024 / 1024} MB)`, audit });
			}

			const name = file.name || 'work-instruction';
			const lower = name.toLowerCase();
			if (!lower.endsWith('.docx') && !lower.endsWith('.pdf')) {
				audit.failure = 'unsupported-extension';
				return fail(400, { error: 'Only .docx and .pdf files are supported', audit });
			}

			const buffer = Buffer.from(await file.arrayBuffer());
			audit.bufferBytes = buffer.byteLength;

			const fallbackMime = lower.endsWith('.pdf')
				? 'application/pdf'
				: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

			let parsed;
			try {
				console.log('[wi-upload] starting parse', { fileName: name, bytes: buffer.byteLength });
				parsed = await parseSpuWorkInstruction({
					buffer,
					mimeType: file.type || fallbackMime,
					originalName: name
				});
				console.log('[wi-upload] parse complete', {
					steps: parsed.steps.length,
					scans: parsed.totalRequiredScans,
					warnings: parsed.warnings.length
				});
			} catch (err: any) {
				audit.failure = 'parser-throw';
				audit.parserError = err?.message ?? String(err);
				audit.parserStack = (err?.stack ?? '').toString().slice(0, 1500);
				console.error('[wi-upload] parser threw', err);
				return fail(400, { error: `Parse failed: ${err?.message ?? 'unknown error'}`, audit });
			}

			audit.parserStepCount = parsed.steps?.length ?? 0;
			audit.parserScanCount = parsed.totalRequiredScans;
			audit.parserWarnings = parsed.warnings;
			audit.parserRawTextLength = parsed.rawContent.length;
			audit.rawTextPreview = parsed.rawContent.slice(0, 800);

			if (!parsed.steps?.length) {
				audit.failure = 'no-steps';
				console.log('[wi-upload] no steps', audit);
				return fail(400, {
					error: 'Parser produced no steps from this document',
					audit
				});
			}

			let dbResult;
			try {
				dbResult = await createSpuWiDraftVersion({
					title: parsed.title,
					originalFileName: name,
					fileSize: file.size,
					mimeType: file.type,
					rawContent: parsed.rawContent,
					parsedSteps: parsed.steps,
					parserVersion: parsed.parserVersion,
					preparedBy: locals.user!.username
				});
				audit.dbWriteOk = true;
				audit.workInstructionId = dbResult.workInstructionId;
				audit.versionId = dbResult.versionId;
				audit.version = dbResult.version;
			} catch (err: any) {
				audit.failure = 'db-write-throw';
				audit.dbError = err?.message ?? String(err);
				audit.dbStack = (err?.stack ?? '').toString().slice(0, 1500);
				console.error('[wi-upload] createSpuWiDraftVersion threw', err);
				return fail(500, {
					error: `DB write failed: ${err?.message ?? 'unknown error'}`,
					audit
				});
			}

			audit.completedAt = new Date().toISOString();
			console.log('[wi-upload] success', {
				steps: parsed.steps.length,
				wi: dbResult.workInstructionId,
				version: dbResult.version
			});

			return {
				parsed: true,
				workInstructionId: dbResult.workInstructionId,
				versionId: dbResult.versionId,
				version: dbResult.version,
				fileName: name,
				title: parsed.title ?? name,
				parserVersion: parsed.parserVersion,
				warnings: parsed.warnings,
				totalRequiredScans: parsed.totalRequiredScans,
				steps: parsed.steps.map((s) => ({
					stepNumber: s.stepNumber,
					title: s.title,
					content: s.content,
					images: s.images ?? [],
					partRequirements: s.partRequirements,
					fieldCount: s.fieldDefinitions.length
				})),
				audit
			};
		} catch (err: any) {
			audit.failure = 'top-level-throw';
			audit.fatalError = err?.message ?? String(err);
			audit.fatalStack = (err?.stack ?? '').toString().slice(0, 1500);
			console.error('[wi-upload] TOP-LEVEL THROW', err);
			return fail(500, {
				error: `Server error: ${err?.message ?? 'unknown'}`,
				audit
			});
		}
	}
};

export const config = { maxDuration: 120 };
