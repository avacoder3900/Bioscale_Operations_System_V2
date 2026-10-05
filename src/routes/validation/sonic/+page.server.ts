import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, User, AuditLog, generateId } from '$lib/server/db';
import { uploadFile, getSignedDownloadUrl } from '$lib/server/r2';
import { uploadViaWorker, getR2Url } from '$lib/server/services/r2';
import { appendSpuJournal } from '$lib/server/spu-journal';
import { DIRECT_MAX_BYTES, directUploadEnabled, headWorkerObject, mintDirectUploadToken } from '$lib/server/sonic-direct';
import {
	ASSAY_LABELS, SONIC_ASSAYS, analyzeSession, referenceFilter, scoreSession, setAssay, setReference, type SonicAssay
} from '$lib/server/sonic/analyze';
import { MIN_REFERENCES } from '$lib/server/sonic/constants';
import { env } from '$env/dynamic/private';
import type { Actions, PageServerLoad } from './$types';

/**
 * Sonic fingerprint (2026-09-15 plan). Like the thermocouple test, the device
 * is triggered by a special barcode (SONIC-, firmware v96) and runs the
 * motion-only assay; a person records the sound with a phone and drops the
 * file here against the unit. The recording is stored in R2 and the session
 * is the DHR record. Waveform analysis comes later, once we have recordings.
 *
 * Two ways in (2026-09-30):
 *   upload          — the file rides the form POST through this function. Vercel
 *                     drops function bodies over 4.5 MB before we run, so this
 *                     path is capped at PROXY_MAX_BYTES.
 *   presign+record  — when SONIC_DIRECT_UPLOAD=1 the browser PUTs the file
 *                     straight to the R2 Worker with a token from `presign`, then
 *                     `record` HEADs the object and writes the session. Up to
 *                     DIRECT_MAX_BYTES. See $lib/server/sonic-direct.
 * Every failed attempt gets an AuditLog row (sonic_recording_upload_failed) so
 * the next "it didn't log" is answerable from the database.
 *
 * Analysis (VALIDATION-08, $lib/server/sonic): after a recording is stored the
 * page calls `analyze`, which decodes it on the server and stores a fingerprint
 * on the session; `setReference` / `setAssay` / `score` manage the hand-picked
 * reference set and the advisory verdict. Compare lives at ./compare.
 */
const AUDIO_EXT = ['wav', 'm4a', 'mp3', 'aac', 'ogg', 'webm', 'flac', 'caf', 'mp4'];
/** Vercel's serverless request-body cap. Bigger bodies never reach this file. */
const PROXY_MAX_BYTES = 4.5 * 1024 * 1024;

type Who = { _id: string; username: string };

function isAudio(fileName: string, mimeType: string): boolean {
	const ext = (fileName.split('.').pop() ?? '').toLowerCase();
	return AUDIO_EXT.includes(ext) || mimeType.startsWith('audio/');
}

function assayOf(v: FormDataEntryValue | null): SonicAssay {
	const s = (v?.toString() ?? '').trim().toUpperCase();
	return (SONIC_ASSAYS as readonly string[]).includes(s) ? (s as SonicAssay) : 'SONIC';
}

/** Strict parse for setAssay: an unknown value must not silently become SONIC. */
function strictAssayOf(v: FormDataEntryValue | null): SonicAssay | null {
	const s = (v?.toString() ?? '').trim().toUpperCase();
	return (SONIC_ASSAYS as readonly string[]).includes(s) ? (s as SonicAssay) : null;
}

function whoOf(locals: App.Locals): Who {
	return { _id: locals.user!._id, username: locals.user!.username };
}

function mbOf(n: number): string {
	return (n / 1048576).toFixed(1);
}

function recordingKey(spuUdi: string, fileName: string, now: Date): string {
	const safe = fileName.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
	return `sonic/${spuUdi}/${now.toISOString().replace(/[:.]/g, '-')}-${safe}`;
}

/**
 * Storage path for the proxied upload. The CV capture flow already stores photos in
 * production through the Cloudflare Worker (R2_WORKER_URL + X-Upload-Secret), whose
 * native R2 binding needs no S3 credentials. The S3 credentials in the Vercel env are
 * wrong (2026-09-25: R2 rejects the access key — "length 24, should be 32") and nobody
 * can edit them right now, so the recording goes through the Worker first and falls
 * back to the S3 client only when the Worker is not configured or refuses. Downloads
 * follow the same rule: the Worker's /file/ URL when it exists, otherwise a presigned
 * S3 URL.
 */
async function storeRecording(key: string, bytes: ArrayBuffer, contentType: string): Promise<{ key: string; size: number }> {
	let workerError: string | null = null;
	if (env.R2_WORKER_URL) {
		try {
			await uploadViaWorker(Buffer.from(bytes), key, contentType);
			return { key, size: bytes.byteLength };
		} catch (err) {
			workerError = err instanceof Error ? err.message : String(err);
			console.warn(`[sonic] worker upload failed, falling back to S3: ${workerError}`);
		}
	}
	try {
		return await uploadFile(key, bytes, contentType);
	} catch (err) {
		const s3Error = err instanceof Error ? err.message : String(err);
		throw new Error(workerError ? `worker: ${workerError}; S3: ${s3Error}` : s3Error);
	}
}

async function recordingUrl(key: string): Promise<string> {
	if (env.R2_WORKER_URL) return getR2Url(key);
	return getSignedDownloadUrl(key, 3600);
}

/** A failed attempt is still evidence. Never throws — a logging failure must not mask the real one. */
async function logFailedAttempt(who: Who, stage: string, reason: string, details: Record<string, unknown>): Promise<void> {
	try {
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: null,
			action: 'sonic_recording_upload_failed',
			newData: { stage, reason, ...details },
			reason,
			changedBy: who.username,
			changedAt: new Date()
		});
	} catch (err) {
		console.warn(`[sonic] could not write failure audit row: ${err instanceof Error ? err.message : String(err)}`);
	}
}

interface StoredRecording {
	spuId: string;
	spuUdi: string;
	key: string;
	fileName: string;
	size: number;
	mimeType: string;
	notes: string;
	via: 'proxy' | 'direct';
	assay: SonicAssay;
}

/** Session + audit + journal for a recording that is confirmed to be in storage. */
async function persistRecording(r: StoredRecording, who: Who, now: Date) {
	const sessionId = generateId();
	await ValidationSession.create({
		_id: sessionId,
		type: 'sonic',
		spuId: r.spuId,
		spuUdi: r.spuUdi,
		status: 'completed',
		startedAt: now,
		completedAt: now,
		userId: who._id,
		results: [
			{
				_id: generateId(),
				testType: 'sonic',
				rawData: { r2Key: r.key, fileName: r.fileName, size: r.size, mimeType: r.mimeType || null, notes: r.notes || null, via: r.via, assay: r.assay },
				processedData: null,
				passed: null,
				notes: r.notes || undefined,
				createdAt: now
			}
		]
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'validation_sessions',
		recordId: sessionId,
		action: 'sonic_recording_upload',
		newData: { spuId: r.spuId, spuUdi: r.spuUdi, r2Key: r.key, fileName: r.fileName, size: r.size, notes: r.notes || null, via: r.via, assay: r.assay },
		changedBy: who.username,
		changedAt: now
	});
	await appendSpuJournal(
		r.spuId,
		`Sonic fingerprint recorded — ${r.fileName} (${mbOf(r.size)} MB)${r.notes ? `\n${r.notes}` : ''}`,
		who,
		{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Sonic fingerprint' }
	);
	return { uploaded: true as const, sessionId, spuUdi: r.spuUdi, fileName: r.fileName, size: r.size };
}

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = (await Spu.find({ status: { $ne: 'retired' } })
		.select('_id udi status')
		.sort({ udi: 1 })
		.lean()) as any[];

	// The fingerprint (~100–250 KB each) stays in the database; the list only needs its status.
	const sessions = (await ValidationSession.find({ type: 'sonic' })
		.select('-results.processedData.fingerprint')
		.sort({ createdAt: -1 })
		.limit(100)
		.lean()) as any[];
	const userIds = [...new Set(sessions.map((s) => s.userId).filter(Boolean))];
	const users = userIds.length ? ((await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()) as any[]) : [];
	const nameOf = new Map(users.map((u) => [u._id, u.username]));

	const recent = await Promise.all(
		sessions.map(async (s) => {
			const r = (s.results ?? [])[0]?.rawData ?? {};
			const p = (s.results ?? [])[0]?.processedData ?? {};
			const a = p?.analysis ?? null;
			const v = p?.verdict ?? null;
			let url: string | null = null;
			try {
				url = r.r2Key ? await recordingUrl(r.r2Key) : null;
			} catch {
				url = null;
			}
			return {
				id: s._id as string,
				spuUdi: (s.spuUdi ?? null) as string | null,
				spuId: (s.spuId ?? null) as string | null,
				fileName: (r.fileName ?? null) as string | null,
				size: (r.size ?? null) as number | null,
				mimeType: (r.mimeType ?? null) as string | null,
				notes: (r.notes ?? null) as string | null,
				recordedBy: nameOf.get(s.userId) ?? null,
				at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
				url,
				assay: (r.assay ?? null) as string | null,
				analysis: a
					? a.error
						? { state: 'error' as const, error: String(a.error) }
						: { state: 'done' as const, durationS: (a.durationS ?? null) as number | null }
					: { state: 'pending' as const },
				reference: !!p?.reference?.on,
				verdict: v ? { passed: v.passedSections as number, total: v.totalSections as number, at: v.at ? new Date(v.at).toISOString() : null } : null
			};
		})
	);

	// Reference-set size per assay, for the "n/3 references" hints. Counted the way the
	// verdict counts them (loadFingerprints): a reference whose re-analysis failed has no
	// fingerprint and does not score, so it must not count here either.
	const refCounts: Record<string, number> = {};
	await Promise.all(
		SONIC_ASSAYS.map(async (k) => {
			refCounts[k] = await ValidationSession.countDocuments({
				type: 'sonic',
				'results.0.processedData.fingerprint': { $ne: null },
				...referenceFilter(k)
			});
		})
	);

	const directUpload = directUploadEnabled();
	return {
		spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status })),
		recent,
		directUpload,
		maxBytes: directUpload ? DIRECT_MAX_BYTES : PROXY_MAX_BYTES,
		assays: SONIC_ASSAYS.map((k) => ({ key: k, label: ASSAY_LABELS[k] })),
		refCounts,
		minReferences: MIN_REFERENCES,
		// Files up to this size always take the proxied path, even with direct
		// upload on — it only needs the Worker's long-standing /upload route.
		proxyMaxBytes: PROXY_MAX_BYTES
	};
};

export const actions: Actions = {
	/** Proxied path: the file rides the multipart POST through this function (≤ 4.5 MB). */
	upload: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const who: Who = { _id: locals.user!._id, username: locals.user!.username };

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const notes = (form.get('notes')?.toString() ?? '').trim();
		const file = form.get('file');
		if (!spuId) return fail(400, { error: 'Pick the unit the recording is of' });
		if (!(file instanceof File) || file.size === 0) {
			await logFailedAttempt(who, 'validate', 'no file or zero bytes (iCloud-only file not downloaded?)', { spuId, fileName: file instanceof File ? file.name : null });
			return fail(400, { error: 'Choose the audio file. If it lives in iCloud, open it in the Files app first so it downloads to the phone.' });
		}
		if (file.size > PROXY_MAX_BYTES) {
			await logFailedAttempt(who, 'validate', 'over proxy size cap', { spuId, fileName: file.name, size: file.size, cap: PROXY_MAX_BYTES });
			return fail(400, { error: `That file is ${mbOf(file.size)} MB — this path takes recordings under ${mbOf(PROXY_MAX_BYTES)} MB` });
		}
		if (!isAudio(file.name, file.type)) {
			await logFailedAttempt(who, 'validate', 'not audio', { spuId, fileName: file.name, mimeType: file.type });
			return fail(400, { error: `Not an audio file (.${AUDIO_EXT.join(', .')})` });
		}

		const spu = (await Spu.findById(spuId).select('udi finalizedAt').lean()) as any;
		if (!spu) return fail(404, { error: 'SPU not found' });

		const now = new Date();
		const key = recordingKey(spu.udi, file.name, now);
		let stored: { key: string; size: number };
		try {
			stored = await storeRecording(key, await file.arrayBuffer(), file.type || 'application/octet-stream');
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			await logFailedAttempt(who, 'storage', reason, { spuId, spuUdi: spu.udi, key, fileName: file.name, size: file.size, mimeType: file.type });
			return fail(500, { error: `Upload to storage failed: ${reason}` });
		}

		return persistRecording(
			{ spuId, spuUdi: spu.udi, key: stored.key, fileName: file.name, size: stored.size, mimeType: file.type, notes, via: 'proxy', assay: assayOf(form.get('assay')) },
			who,
			now
		);
	},

	/** Direct path, step 1: validate and hand the browser a one-key, short-lived Worker token. */
	presign: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const who: Who = { _id: locals.user!._id, username: locals.user!.username };
		if (!directUploadEnabled()) return fail(400, { error: 'Direct upload is not enabled on this deployment' });

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const fileName = (form.get('fileName')?.toString() ?? '').trim();
		const size = Number(form.get('size')?.toString() ?? '');
		const mimeType = form.get('mimeType')?.toString() ?? '';
		if (!spuId) return fail(400, { error: 'Pick the unit the recording is of' });
		if (!fileName || !Number.isFinite(size) || size <= 0) {
			await logFailedAttempt(who, 'validate', 'no file or zero bytes (iCloud-only file not downloaded?)', { spuId, fileName, size, via: 'direct' });
			return fail(400, { error: 'Choose the audio file. If it lives in iCloud, open it in the Files app first so it downloads to the phone.' });
		}
		if (size > DIRECT_MAX_BYTES) {
			await logFailedAttempt(who, 'validate', 'over direct size cap', { spuId, fileName, size, cap: DIRECT_MAX_BYTES, via: 'direct' });
			return fail(400, { error: `That file is ${mbOf(size)} MB — keep recordings under ${mbOf(DIRECT_MAX_BYTES)} MB` });
		}
		if (!isAudio(fileName, mimeType)) {
			await logFailedAttempt(who, 'validate', 'not audio', { spuId, fileName, mimeType, via: 'direct' });
			return fail(400, { error: `Not an audio file (.${AUDIO_EXT.join(', .')})` });
		}
		const spu = (await Spu.findById(spuId).select('udi').lean()) as any;
		if (!spu) return fail(404, { error: 'SPU not found' });

		const key = recordingKey(spu.udi, fileName, new Date());
		const grant = await mintDirectUploadToken(key, DIRECT_MAX_BYTES);
		return { presign: { ...grant, spuUdi: spu.udi as string } };
	},

	/** Direct path, step 2: the browser says the PUT succeeded; trust storage, not the browser. */
	record: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const who: Who = { _id: locals.user!._id, username: locals.user!.username };
		if (!directUploadEnabled()) return fail(400, { error: 'Direct upload is not enabled on this deployment' });

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const key = form.get('key')?.toString() ?? '';
		const fileName = (form.get('fileName')?.toString() ?? '').trim();
		const size = Number(form.get('size')?.toString() ?? '');
		const mimeType = form.get('mimeType')?.toString() ?? '';
		const notes = (form.get('notes')?.toString() ?? '').trim();
		if (!spuId || !key || !fileName) return fail(400, { error: 'Missing upload details' });

		const spu = (await Spu.findById(spuId).select('udi').lean()) as any;
		if (!spu) return fail(404, { error: 'SPU not found' });
		if (!key.startsWith(`sonic/${spu.udi}/`)) {
			await logFailedAttempt(who, 'record', 'key does not belong to this unit', { spuId, spuUdi: spu.udi, key, via: 'direct' });
			return fail(400, { error: 'That upload does not belong to this unit' });
		}

		let head: { size: number; contentType: string } | null;
		try {
			head = await headWorkerObject(key);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			await logFailedAttempt(who, 'record', `HEAD failed: ${reason}`, { spuId, spuUdi: spu.udi, key, fileName, size, via: 'direct' });
			return fail(502, { error: `Could not confirm the file in storage: ${reason}` });
		}
		if (!head) {
			await logFailedAttempt(who, 'record', 'object not found after PUT', { spuId, spuUdi: spu.udi, key, fileName, size, via: 'direct' });
			return fail(400, { error: 'The file did not arrive in storage. Try the upload again.' });
		}
		if (Number.isFinite(size) && size > 0 && head.size !== size) {
			await logFailedAttempt(who, 'record', 'size mismatch', { spuId, spuUdi: spu.udi, key, fileName, size, storedSize: head.size, via: 'direct' });
			return fail(400, { error: `Storage has ${mbOf(head.size)} MB but the phone sent ${mbOf(size)} MB — the upload was cut short. Try again.` });
		}

		return persistRecording(
			{ spuId, spuUdi: spu.udi, key, fileName, size: head.size, mimeType: mimeType || head.contentType, notes, via: 'direct', assay: assayOf(form.get('assay')) },
			who,
			new Date()
		);
	},

	/** VALIDATION-08: decode the stored recording on the server and store its fingerprint; then score if possible. */
	analyze: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const sessionId = (await request.formData()).get('sessionId')?.toString() ?? '';
		if (!sessionId) return fail(400, { error: 'Missing recording' });
		const who = whoOf(locals);
		try {
			const r = await analyzeSession(sessionId, who);
			if (!r.ok) return fail(422, { error: `Could not analyze: ${r.error}`, analyzedId: sessionId });
		} catch (err) {
			return fail(500, { error: err instanceof Error ? err.message : String(err), analyzedId: sessionId });
		}
		// The fingerprint is stored and audited at this point; a scoring failure must not
		// report the analysis itself as failed.
		try {
			const v = await scoreSession(sessionId, who);
			return { analyzed: true, analyzedId: sessionId, verdictStatus: v.status as string, referenceCount: v.referenceCount };
		} catch (err) {
			console.warn(`[sonic] auto-score of ${sessionId} failed: ${err instanceof Error ? err.message : String(err)}`);
			return {
				analyzed: true,
				analyzedId: sessionId,
				verdictStatus: 'error' as string,
				referenceCount: 0,
				scoreError: err instanceof Error ? err.message : String(err)
			};
		}
	},

	/** Re-score against today's reference set (stores a new advisory verdict + journal line). */
	score: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const sessionId = (await request.formData()).get('sessionId')?.toString() ?? '';
		if (!sessionId) return fail(400, { error: 'Missing recording' });
		let v: Awaited<ReturnType<typeof scoreSession>>;
		try {
			v = await scoreSession(sessionId, whoOf(locals));
		} catch (err) {
			return fail(422, { error: err instanceof Error ? err.message : String(err) });
		}
		if (v.status === 'insufficient') {
			return fail(400, { error: `Need at least ${MIN_REFERENCES} reference recordings of this assay (have ${v.referenceCount}).` });
		}
		if (v.status === 'no-assay') return fail(400, { error: 'Set the assay of this recording first.' });
		if (v.status === 'not-analyzed') return fail(400, { error: 'Analyze the recording first.' });
		return { scored: true, passed: v.passed, total: v.total };
	},

	setReference: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sessionId = form.get('sessionId')?.toString() ?? '';
		const on = form.get('on')?.toString() === '1';
		if (!sessionId) return fail(400, { error: 'Missing recording' });
		try {
			await setReference(sessionId, on, whoOf(locals));
			return { referenceSet: on };
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}
	},

	setAssay: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();
		const form = await request.formData();
		const sessionId = form.get('sessionId')?.toString() ?? '';
		if (!sessionId) return fail(400, { error: 'Missing recording' });
		const assay = strictAssayOf(form.get('assay'));
		if (!assay) return fail(400, { error: `Assay must be one of ${SONIC_ASSAYS.join(', ')}` });
		try {
			await setAssay(sessionId, assay, whoOf(locals));
			return { assaySet: true };
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}
	}
};

export const config = { maxDuration: 60 };
