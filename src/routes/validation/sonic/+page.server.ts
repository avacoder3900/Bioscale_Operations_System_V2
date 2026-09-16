import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Spu, ValidationSession, User, AuditLog, generateId } from '$lib/server/db';
import { uploadFile, getSignedDownloadUrl } from '$lib/server/r2';
import { appendSpuJournal } from '$lib/server/spu-journal';
import type { Actions, PageServerLoad } from './$types';

/**
 * Sonic fingerprint (2026-09-15 plan). Like the thermocouple test, the device
 * is triggered by a special barcode (SONIC-, firmware v95) and runs the
 * motion-only assay; a person records the sound with a phone and drops the
 * file here against the unit. The recording is stored in R2 and the session
 * is the DHR record. Waveform analysis comes later, once we have recordings.
 */
const AUDIO_EXT = ['wav', 'm4a', 'mp3', 'aac', 'ogg', 'webm', 'flac', 'caf', 'mp4'];
const MAX_BYTES = 80 * 1024 * 1024;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spus = (await Spu.find({ status: { $ne: 'retired' } })
		.select('_id udi status')
		.sort({ udi: 1 })
		.lean()) as any[];

	const sessions = (await ValidationSession.find({ type: 'sonic' })
		.sort({ createdAt: -1 })
		.limit(40)
		.lean()) as any[];
	const userIds = [...new Set(sessions.map((s) => s.userId).filter(Boolean))];
	const users = userIds.length ? ((await User.find({ _id: { $in: userIds } }, { username: 1 }).lean()) as any[]) : [];
	const nameOf = new Map(users.map((u) => [u._id, u.username]));

	const recent = await Promise.all(
		sessions.map(async (s) => {
			const r = (s.results ?? [])[0]?.rawData ?? {};
			let url: string | null = null;
			try {
				url = r.r2Key ? await getSignedDownloadUrl(r.r2Key, 3600) : null;
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
				url
			};
		})
	);

	return {
		spus: spus.map((s) => ({ id: s._id, udi: s.udi, status: s.status })),
		recent
	};
};

export const actions: Actions = {
	upload: async ({ request, locals }) => {
		requirePermission(locals.user, 'spu:write');
		await connectDB();

		const form = await request.formData();
		const spuId = form.get('spuId')?.toString() ?? '';
		const notes = (form.get('notes')?.toString() ?? '').trim();
		const file = form.get('file');
		if (!spuId) return fail(400, { error: 'Pick the unit the recording is of' });
		if (!(file instanceof File) || file.size === 0) return fail(400, { error: 'Choose the audio file' });
		if (file.size > MAX_BYTES) return fail(400, { error: `That file is ${(file.size / 1048576).toFixed(0)} MB — keep recordings under ${MAX_BYTES / 1048576} MB` });
		const ext = (file.name.split('.').pop() ?? '').toLowerCase();
		if (!AUDIO_EXT.includes(ext) && !file.type.startsWith('audio/')) {
			return fail(400, { error: `Not an audio file (.${AUDIO_EXT.join(', .')})` });
		}

		const spu = (await Spu.findById(spuId).select('udi finalizedAt').lean()) as any;
		if (!spu) return fail(404, { error: 'SPU not found' });

		const now = new Date();
		const safe = file.name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
		const key = `sonic/${spu.udi}/${now.toISOString().replace(/[:.]/g, '-')}-${safe}`;
		let stored: { key: string; size: number };
		try {
			stored = await uploadFile(key, await file.arrayBuffer(), file.type || 'application/octet-stream');
		} catch (err) {
			return fail(500, { error: `Upload to storage failed: ${err instanceof Error ? err.message : String(err)}` });
		}

		const who = { _id: locals.user!._id, username: locals.user!.username };
		const sessionId = generateId();
		await ValidationSession.create({
			_id: sessionId,
			type: 'sonic',
			spuId,
			spuUdi: spu.udi,
			status: 'completed',
			startedAt: now,
			completedAt: now,
			userId: who._id,
			results: [
				{
					_id: generateId(),
					testType: 'sonic',
					rawData: { r2Key: stored.key, fileName: file.name, size: stored.size, mimeType: file.type || null, notes: notes || null },
					processedData: null,
					passed: null,
					notes: notes || undefined,
					createdAt: now
				}
			]
		});
		await AuditLog.create({
			_id: generateId(),
			tableName: 'validation_sessions',
			recordId: sessionId,
			action: 'sonic_recording_upload',
			newData: { spuId, spuUdi: spu.udi, r2Key: stored.key, fileName: file.name, size: stored.size, notes: notes || null },
			changedBy: who.username,
			changedAt: now
		});
		await appendSpuJournal(
			spuId,
			`Sonic fingerprint recorded — ${file.name} (${(stored.size / 1048576).toFixed(1)} MB)${notes ? `\n${notes}` : ''}`,
			who,
			{ source: 'validation', refKind: 'validation_session', refId: sessionId, refLabel: 'Sonic fingerprint' }
		);

		return { uploaded: true, sessionId, spuUdi: spu.udi, fileName: file.name, size: stored.size };
	}
};

export const config = { maxDuration: 60 };
