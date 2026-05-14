/**
 * POST /api/agent/transcribe
 *
 * Voice-input transcription for the Ask BIMS widget (Phase M.1). Accepts a
 * multipart/form-data POST with one file field `audio`. Forwards the audio to
 * OpenAI Whisper (whisper-1, $0.006/min) and returns the transcript text. The
 * widget then puts the transcript in its input field for the operator to
 * confirm before firing the question — we deliberately do NOT auto-submit
 * after transcription.
 *
 * Cost control:
 *   - Workspace daily cap: $2 by default, override via ASK_BIMS_DAILY_CAP_WHISPER_USD.
 *     Enforced via AskBimsTranscribeLog sum-by-day before each call.
 *   - We pass response_format=verbose_json so Whisper returns audio duration,
 *     letting us bill the *real* duration rather than guessing from byte size.
 *   - Audio bigger than 25 MB (Whisper's hard limit) is rejected before upload.
 *
 * No transcript text is stored server-side. Only cost signals land in
 * ask_bims_transcribe_logs. Raw speech can contain wrong-room overhear so we
 * stay zero-retention by policy.
 *
 * Errors are JSON, classified like /api/agent/ask:
 *   - 'unconfigured' (permanent — no OPENAI_API_KEY on the server)
 *   - 'permission' (permanent — user not logged in)
 *   - 'bad_audio' (permanent — missing/oversized/wrong-type audio)
 *   - 'daily_cap' (permanent until midnight — workspace cap hit)
 *   - 'rate_limit' (retryable — Whisper 429)
 *   - 'service_unavailable' (retryable — Whisper 5xx / network)
 *   - 'internal' (uncategorized)
 */
import { json, error } from '@sveltejs/kit';
import { connectDB, AskBimsTranscribeLog } from '$lib/server/db';
import type { RequestHandler } from './$types';

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // Whisper's documented hard cap
const WHISPER_RATE_PER_SEC = 0.006 / 60; // $0.006/min = $0.0001/sec
const WORKSPACE_DAILY_CAP_USD = Number(process.env.ASK_BIMS_DAILY_CAP_WHISPER_USD ?? 2);

function startOfTodayUtc(): Date {
	const d = new Date();
	d.setUTCHours(0, 0, 0, 0);
	return d;
}

async function workspaceSpentToday(): Promise<number> {
	await connectDB();
	const since = startOfTodayUtc();
	const agg = await AskBimsTranscribeLog.aggregate([
		{ $match: { timestamp: { $gte: since } } },
		{ $group: { _id: null, total: { $sum: '$costUsd' } } }
	]);
	return agg[0]?.total ?? 0;
}

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');

	const apiKey = process.env.OPENAI_API_KEY;
	if (!apiKey) {
		return json({
			error: 'Voice input is not configured on this server (OPENAI_API_KEY not set).',
			errorClass: 'unconfigured',
			retryable: false
		}, { status: 503 });
	}

	// Workspace cap check BEFORE pulling the multipart body — cheap exit.
	const spent = await workspaceSpentToday();
	if (spent >= WORKSPACE_DAILY_CAP_USD) {
		return json({
			error: `Voice input daily cap of $${WORKSPACE_DAILY_CAP_USD.toFixed(2)} reached ($${spent.toFixed(2)} spent). Type your question instead, or wait until midnight UTC.`,
			errorClass: 'daily_cap',
			retryable: false,
			cap: { capUsd: WORKSPACE_DAILY_CAP_USD, spentUsd: spent }
		}, { status: 429 });
	}

	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'multipart/form-data with field "audio" required.', errorClass: 'bad_audio', retryable: false }, { status: 400 });
	}
	const audio = form.get('audio');
	// Both File and Blob can land here depending on the client; we treat them
	// uniformly via Blob. Bare strings (the other FormData value type) are not
	// valid audio input.
	if (typeof audio === 'string' || audio == null || typeof (audio as any).arrayBuffer !== 'function') {
		return json({ error: 'audio field missing or not a file/blob.', errorClass: 'bad_audio', retryable: false }, { status: 400 });
	}
	const audioBlob = audio as Blob;
	if (audioBlob.size === 0) {
		return json({ error: 'audio is empty.', errorClass: 'bad_audio', retryable: false }, { status: 400 });
	}
	if (audioBlob.size > MAX_AUDIO_BYTES) {
		return json({ error: `audio exceeds Whisper's ${MAX_AUDIO_BYTES} byte limit (got ${audioBlob.size}).`, errorClass: 'bad_audio', retryable: false }, { status: 413 });
	}

	// Forward to Whisper.
	const upstream = new FormData();
	const filename = typeof (audio as any).name === 'string' && (audio as any).name ? (audio as any).name : 'audio.webm';
	upstream.append('file', audioBlob, filename);
	upstream.append('model', 'whisper-1');
	upstream.append('response_format', 'verbose_json');
	upstream.append('language', 'en');

	let res: Response;
	try {
		res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
			method: 'POST',
			headers: { Authorization: `Bearer ${apiKey}` },
			body: upstream
		});
	} catch (err: any) {
		void AskBimsTranscribeLog.create({
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			audioDurationSec: 0,
			costUsd: 0,
			errorClass: 'service_unavailable'
		}).catch(() => {});
		return json({
			error: 'Voice service is unreachable right now. Please try again shortly.',
			errorClass: 'service_unavailable',
			retryable: true
		}, { status: 503 });
	}

	if (!res.ok) {
		const errClass = res.status === 401 ? 'auth'
			: res.status === 429 ? 'rate_limit'
			: res.status >= 500 ? 'service_unavailable'
			: 'bad_audio';
		const retryable = errClass === 'rate_limit' || errClass === 'service_unavailable';
		const bodyText = await res.text().catch(() => '');
		void AskBimsTranscribeLog.create({
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			audioDurationSec: 0,
			costUsd: 0,
			errorClass: errClass
		}).catch(() => {});
		return json({
			error: `Whisper returned ${res.status}. ${bodyText.slice(0, 200)}`,
			errorClass: errClass,
			retryable
		}, { status: res.status });
	}

	const payload = await res.json().catch(() => null) as { text?: string; duration?: number } | null;
	if (!payload || typeof payload.text !== 'string') {
		return json({ error: 'Whisper returned an unexpected payload shape.', errorClass: 'internal', retryable: false }, { status: 502 });
	}

	const durationSec = typeof payload.duration === 'number' && payload.duration > 0 ? payload.duration : 0;
	const costUsd = durationSec * WHISPER_RATE_PER_SEC;

	void AskBimsTranscribeLog.create({
		userId: locals.user._id,
		username: locals.user.username,
		timestamp: new Date(),
		audioDurationSec: durationSec,
		costUsd
	}).catch(() => {});

	return json({
		text: payload.text.trim(),
		durationSec,
		costUsd
	});
};
