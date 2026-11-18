/**
 * VOICE-01: Kanban → Journal. Claude-written digests of spoken voice memos,
 * newest day first. Read-only: digests are filed over MCP (voice_memo_digest_write).
 *
 * The digest is what people read. The source transcript is shown (collapsed)
 * only to the person who spoke it and to admins — a voice memo is someone's
 * raw speech, the digest is the shareable version.
 *
 * Notes are sorted by person: the "people" strip counts each speaker's notes
 * (the speaker comes from the initials in the title — "EOD GV" — or the webhook
 * key), and ?who=<username> narrows the page to one person's notes and digests.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB, User, VoiceMemo, VoiceMemoDigest } from '$lib/server/db';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import { renderDigestMarkdown } from '$lib/server/voice-memos/markdown';
import { initialsOf } from '$lib/server/voice-memos/speakers';
import type { PageServerLoad } from './$types';

const DAYS_SHOWN = 90;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const since = new Date(Date.now() - DAYS_SHOWN * 86_400_000);
	const sinceDay = since.toISOString().slice(0, 10);

	// Every note in the window, without transcripts: the per-person counts.
	const recent: any[] = await VoiceMemo.find({ recordedAt: { $gte: since } })
		.select('_id speaker initials kind experimentRef title recordedAt processed sourceDeletedAt')
		.sort({ recordedAt: -1 })
		.lean();

	const usernames = [...new Set(recent.map((m) => m.speaker?.username).filter(Boolean))];
	const users: any[] = await User.find({ username: { $in: usernames } })
		.select('username firstName lastName')
		.lean();
	const userByName = new Map(users.map((u) => [u.username, u]));

	const people = usernames
		.map((username) => {
			const mine = recent.filter((m) => m.speaker?.username === username);
			const u = userByName.get(username);
			return {
				username,
				name: [u?.firstName, u?.lastName].filter(Boolean).join(' ') || username,
				initials: mine.find((m) => m.initials)?.initials ?? (u ? initialsOf(u) : null) ?? username.slice(0, 2).toUpperCase(),
				total: mine.length,
				pending: mine.filter((m) => !m.processed).length,
				lastAt: mine[0]?.recordedAt ?? null
			};
		})
		.sort((a, b) => +new Date(b.lastAt ?? 0) - +new Date(a.lastAt ?? 0));

	const whoParam = url.searchParams.get('who');
	const who = whoParam && people.some((p) => p.username === whoParam) ? whoParam : null;

	const digests: any[] = await VoiceMemoDigest.find({
		status: 'current',
		date: { $gte: sinceDay },
		...(who ? { speakers: who } : {})
	})
		.sort({ date: -1, createdAt: -1 })
		.lean();

	const isAdmin = hasPermission(locals.user, 'admin:full');
	const viewer = locals.user.username;
	const canSee = (speaker: string | null | undefined) => isAdmin || speaker === viewer;

	// Transcripts are loaded only for memos this viewer may read.
	const wantedIds = [
		...new Set([
			...digests.flatMap((d) => d.memoIds ?? []),
			...(who ? recent.filter((m) => m.speaker?.username === who).map((m) => m._id) : [])
		])
	];
	const memos: any[] = await VoiceMemo.find({ _id: { $in: wantedIds } })
		.select('_id speaker initials kind experimentRef title transcript recordedAt processed digestIds sourceDeletedAt')
		.lean();
	const memoById = new Map(memos.map((m) => [m._id, m]));

	const source = (m: any) => ({
		id: m._id,
		speaker: m.speaker?.username ?? null,
		initials: m.initials ?? null,
		kind: m.kind,
		experimentRef: m.experimentRef ?? null,
		title: m.title ?? null,
		recordedAt: m.recordedAt,
		processed: !!m.processed,
		deletedInVoicenotes: !!m.sourceDeletedAt,
		transcript: canSee(m.speaker?.username) ? (m.transcript ?? '') : null
	});

	const days: { date: string; digests: any[] }[] = [];
	for (const d of digests) {
		let day = days.find((x) => x.date === d.date);
		if (!day) days.push((day = { date: d.date, digests: [] }));
		day.digests.push({
			id: d._id,
			title: d.title,
			html: renderDigestMarkdown(d.summary ?? ''),
			speakers: d.speakers ?? [],
			version: d.version ?? 1,
			authoredBy: d.authoredBy,
			createdAt: d.createdAt,
			sources: (d.memoIds ?? [])
				.map((id: string) => memoById.get(id))
				.filter(Boolean)
				.map(source)
		});
	}

	const pending = recent
		.filter((m) => !m.processed && (!who || m.speaker?.username === who))
		.slice(0, 50);

	return JSON.parse(
		JSON.stringify({
			days,
			people,
			who,
			// One person's notes, newest first — their landing spot.
			notes: who
				? recent
						.filter((m) => m.speaker?.username === who)
						.map((m) => memoById.get(m._id))
						.filter(Boolean)
						.map(source)
				: [],
			pending: pending.map((m) => ({
				id: m._id,
				speaker: m.speaker?.username ?? null,
				kind: m.kind,
				experimentRef: m.experimentRef ?? null,
				title: m.title ?? null,
				recordedAt: m.recordedAt
			}))
		})
	);
};
