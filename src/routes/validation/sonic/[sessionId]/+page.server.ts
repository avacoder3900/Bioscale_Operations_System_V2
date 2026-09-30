import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, User } from '$lib/server/db';
import { liveVerdict, recordingUrl } from '$lib/server/sonic/analyze';
import { ACTIVE_RISE_DB, FRAME_S, TICK_S, MIN_REFERENCES, PASS_INSIDE_PCT } from '$lib/server/sonic/constants';
import { percentile } from '$lib/server/sonic/stats';
import type { Fingerprint } from '$lib/server/sonic/features';
import type { PageServerLoad } from './$types';

/** One sonic recording: its fingerprint charts and its advisory verdict (VALIDATION-08 §8.2). */
export const load: PageServerLoad = async ({ locals, params }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const s = (await ValidationSession.findById(params.sessionId).lean()) as any;
	if (!s || s.type !== 'sonic') throw error(404, 'Sonic recording not found');
	const res = s.results?.[0] ?? {};
	const raw = res.rawData ?? {};
	const p = res.processedData ?? {};
	const fp = (p.fingerprint ?? null) as Fingerprint | null;
	const user = s.userId ? ((await User.findById(s.userId, { username: 1 }).lean()) as any) : null;

	let charts = null;
	if (fp) {
		const quiet = percentile(fp.levelDb, 20);
		const binT = fp.levelDb.map((_, b) => (b + 0.5) * fp.binS);
		// Log-spaced spectrum points (≈400) keep the chart light.
		const psdX: number[] = [];
		const psdY: number[] = [];
		let lastF = 0;
		fp.psdDb.forEach((v, k) => {
			const f = k * fp.psdHzStep;
			if (f < 50) return;
			if (f < lastF * 1.01) return;
			lastF = f;
			psdX.push(Math.round(f));
			psdY.push(v);
		});
		charts = {
			envT: fp.envDb.map((_, i) => Math.round(i * FRAME_S * 100) / 100),
			envDb: fp.envDb,
			binT,
			levelDb: fp.levelDb,
			domHz: fp.domHz.map((h, b) => (fp.levelDb[b] > quiet + ACTIVE_RISE_DB ? h : null)),
			// ≤ 400 columns for the heatmap (power-average neighbouring bins).
			bands: (() => {
				const stride = Math.max(1, Math.ceil(fp.bands.length / 400));
				const out: number[][] = [];
				for (let b = 0; b < fp.bands.length; b += stride) {
					const grp = fp.bands.slice(b, b + stride);
					out.push(grp[0].map((_, q) => Math.round(10 * Math.log10(grp.reduce((s, r) => s + 10 ** (r[q] / 10), 0) / grp.length) * 10) / 10));
				}
				return out;
			})(),
			psdX,
			psdY,
			events: fp.events,
			summary: fp.summary,
			durationS: fp.durationS
		};
	}

	return {
		session: {
			id: s._id as string,
			spuId: (s.spuId ?? null) as string | null,
			spuUdi: (s.spuUdi ?? '?') as string,
			at: s.createdAt ? new Date(s.createdAt).toISOString() : null,
			recordedBy: user?.username ?? null,
			fileName: (raw.fileName ?? null) as string | null,
			size: (raw.size ?? null) as number | null,
			notes: (raw.notes ?? null) as string | null,
			assay: (raw.assay ?? null) as string | null,
			url: raw.r2Key ? await recordingUrl(raw.r2Key) : null,
			analysis: p.analysis ? JSON.parse(JSON.stringify(p.analysis)) : null,
			reference: !!p.reference?.on,
			storedVerdict: p.verdict ? JSON.parse(JSON.stringify(p.verdict)) : null
		},
		charts,
		live: fp ? await liveVerdict(s._id).catch((err) => {
			// The live score is a convenience; a compare failure must not take the page down.
			console.warn(`[sonic] live verdict for ${s._id} failed: ${err instanceof Error ? err.message : String(err)}`);
			return null;
		}) : null,
		tickS: TICK_S,
		minReferences: MIN_REFERENCES,
		passPct: PASS_INSIDE_PCT
	};
};
