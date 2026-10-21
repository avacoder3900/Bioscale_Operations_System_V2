/**
 * VOICE-01: Voicenotes webhook receiver.
 *
 *   POST /api/webhooks/voicenotes?key=<per-person secret>
 *
 * Configure in Voicenotes → profile → Integrations → Webhooks, events
 * "Creating Notes" AND "Updating Notes" (and "Deleting Notes" if you want the
 * deleted flag). Setup + rollout: docs/VOICE-MEMOS.md.
 *
 * Auth is the URL key only — Voicenotes cannot send headers or sign requests.
 * The key maps to the speaker (VOICENOTES_WEBHOOK_KEYS), so attribution never
 * comes from the payload. route-policy.ts already treats `?key=` requests as the
 * machine surface; this handler is the only check.
 *
 * Every authenticated delivery gets 200 — including notes the allowlist drops
 * and payloads that cannot be parsed — so Voicenotes never retries into a loop.
 * Dropped notes are not persisted; only a one-line log without content.
 *
 * GET with a valid key returns {ok:true} so the URL can be checked in a browser.
 */
import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, User, VoiceMemoCapture } from '$lib/server/db';
import { parseKeyMap, usernameForKey } from '$lib/server/voice-memos/keys';
import { parseVoicenotesPayload, allowlistFromEnv } from '$lib/server/voice-memos/parse';
import { ingestVoicenote } from '$lib/server/voice-memos/ingest';
import type { RequestHandler } from './$types';

const MAX_BODY_BYTES = 1024 * 1024;

async function resolveSpeaker(url: URL): Promise<{ _id: string; username: string } | null> {
	const username = usernameForKey(url.searchParams.get('key'), parseKeyMap(env.VOICENOTES_WEBHOOK_KEYS));
	if (!username) return null;
	await connectDB();
	const user: any = await User.findOne({ username, isActive: true }).select('_id username').lean();
	return user ? { _id: String(user._id), username: user.username } : null;
}

const unauthorized = () => json({ error: 'Unauthorized' }, { status: 401 });

export const GET: RequestHandler = async ({ url }) => {
	const speaker = await resolveSpeaker(url);
	if (!speaker) return unauthorized();
	return json({ ok: true, speaker: speaker.username });
};

export const POST: RequestHandler = async ({ request, url }) => {
	const speaker = await resolveSpeaker(url);
	if (!speaker) return unauthorized();

	const text = await request.text();
	if (text.length > MAX_BODY_BYTES) return json({ ok: false, error: 'Payload too large' }, { status: 413 });

	let body: unknown = null;
	try {
		body = JSON.parse(text);
	} catch {
		body = { _unparsed: text.slice(0, 20000) };
	}

	const parsed = parseVoicenotesPayload(body);
	const capture = env.VOICENOTES_CAPTURE_RAW === 'true';

	let outcome: string;
	let memoId: string | undefined;
	try {
		const result = await ingestVoicenote({
			parsed,
			speaker,
			raw: body,
			allowlist: allowlistFromEnv(env.VOICENOTES_TAGS, env.VOICENOTES_SPOKEN_TRIGGERS)
		});
		outcome = result.outcome;
		memoId = result.memoId;
	} catch (e) {
		console.error('[voicenotes] ingest failed', { speaker: speaker.username, event: parsed.event, error: (e as Error)?.message });
		if (capture) await VoiceMemoCapture.create({ speaker: speaker.username, event: parsed.event, outcome: 'error', body }).catch(() => {});
		// 500 so Voicenotes retries — this is our fault, not the payload's.
		return json({ ok: false, error: 'Ingest failed' }, { status: 500 });
	}

	if (capture) {
		await VoiceMemoCapture.create({ speaker: speaker.username, event: parsed.event, outcome, body }).catch((e: Error) =>
			console.error('[voicenotes] capture failed', e?.message)
		);
	}
	if (outcome === 'dropped' || outcome === 'invalid' || outcome === 'conflict') {
		console.log('[voicenotes]', { receivedAt: new Date().toISOString(), speaker: speaker.username, event: parsed.event, outcome });
	}

	return json({ ok: true, outcome, ...(memoId ? { memoId } : {}) });
};
