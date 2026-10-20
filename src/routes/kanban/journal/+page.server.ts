/**
 * VOICE-01: Kanban → Journal. Claude-written digests of spoken voice memos,
 * newest day first. Read-only: digests are filed over MCP (voice_memo_digest_write).
 *
 * The digest is what people read. The source transcript is shown (collapsed)
 * only to the person who spoke it and to admins — a voice memo is someone's
 * raw speech, the digest is the shareable version.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB, VoiceMemo, VoiceMemoDigest } from '$lib/server/db';
import { requirePermission, hasPermission } from '$lib/server/permissions';
import { renderDigestMarkdown } from '$lib/server/voice-memos/markdown';
import type { PageServerLoad } from './$types';

const DAYS_SHOWN = 90;

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'kanban:read');
	await connectDB();

	const sinceDay = new Date(Date.now() - DAYS_SHOWN * 86_400_000).toISOString().slice(0, 10);
	const digests: any[] = await VoiceMemoDigest.find({ status: 'current', date: { $gte: sinceDay } })
		.sort({ date: -1, createdAt: -1 })
		.lean();

	const memoIds = [...new Set(digests.flatMap((d) => d.memoIds ?? []))];
	const [memos, pending]: [any[], any[]] = await Promise.all([
		VoiceMemo.find({ _id: { $in: memoIds } })
			.select('_id speaker kind experimentRef title transcript recordedAt sourceDeletedAt')
			.lean(),
		VoiceMemo.find({ processed: false })
			.select('_id speaker kind experimentRef title recordedAt')
			.sort({ recordedAt: -1 })
			.limit(50)
			.lean()
	]);

	const isAdmin = hasPermission(locals.user, 'admin:full');
	const viewer = locals.user.username;
	const memoById = new Map(memos.map((m) => [m._id, m]));

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
				.map((m: any) => {
					const canSeeTranscript = isAdmin || m.speaker?.username === viewer;
					return {
						id: m._id,
						speaker: m.speaker?.username ?? null,
						kind: m.kind,
						experimentRef: m.experimentRef ?? null,
						title: m.title ?? null,
						recordedAt: m.recordedAt,
						deletedInVoicenotes: !!m.sourceDeletedAt,
						transcript: canSeeTranscript ? (m.transcript ?? '') : null
					};
				})
		});
	}

	return JSON.parse(
		JSON.stringify({
			days,
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
