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
					partCount: (v.parts ?? []).length,
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
						partCount: ((activeVersion as any).parts ?? []).length,
						barcodeFieldCount: ((activeVersion as any).parts ?? []).reduce(
							(n: number, p: any) => n + (p.fieldDefinitions ?? []).length,
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
					parts: parsed.parts.length,
					scans: parsed.totalRequiredScans,
					htmlBytes: parsed.renderedHtml.length,
					warnings: parsed.warnings.length
				});
			} catch (err: any) {
				audit.failure = 'parser-throw';
				audit.parserError = err?.message ?? String(err);
				audit.parserStack = (err?.stack ?? '').toString().slice(0, 1500);
				console.error('[wi-upload] parser threw', err);
				return fail(400, { error: `Parse failed: ${err?.message ?? 'unknown error'}`, audit });
			}

			audit.parserPartCount = parsed.parts?.length ?? 0;
			audit.parserScanCount = parsed.totalRequiredScans;
			audit.parserWarnings = parsed.warnings;
			audit.parserRawTextLength = parsed.rawContent.length;
			audit.parserRenderedHtmlLength = parsed.renderedHtml.length;
			audit.rawTextPreview = parsed.rawContent.slice(0, 600);

			let dbResult;
			try {
				dbResult = await createSpuWiDraftVersion({
					title: parsed.title,
					originalFileName: name,
					fileSize: file.size,
					mimeType: file.type,
					rawContent: parsed.rawContent,
					renderedHtml: parsed.renderedHtml,
					parts: parsed.parts,
					steps: parsed.steps,
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
				parts: parsed.parts.length,
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
				partCount: parsed.parts.length,
				partsList: parsed.parts.map((p) => ({
					partNumber: p.partNumber,
					partName: p.partName,
					quantity: p.quantity
				})),
				audit
			};
		} catch (err: any) {
			// SvelteKit control-flow throws (error(403) from requirePermission,
			// redirects) must propagate — converting them to fail(500) masked
			// permission denials as server errors.
			if (err && typeof err === 'object' && 'status' in err) throw err;
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
