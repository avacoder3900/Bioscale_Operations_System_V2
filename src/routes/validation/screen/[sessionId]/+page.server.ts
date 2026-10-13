import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { loadScreenCriteria } from '$lib/server/screen/ingest';
import { summarizeSession } from '$lib/server/screen/summarize';
import type { PageServerLoad } from './$types';

/** One screen in full: every row by level, the summary, the level-2 background records. */
export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const s = (await ValidationSession.findById(params.sessionId).lean()) as any;
	if (!s || s.type !== 'screen') throw error(404, 'Screen session not found');
	const criteria = await loadScreenCriteria();
	const session = summarizeSession(s, criteria);
	// Full records (readings) only on the detail page.
	const records = Object.values(s.rawData?.records ?? {}).map((r: any) => ({
		runIndex: r.runIndex,
		assayId: r.assayId,
		startTime: r.startTime,
		durationS: r.durationS,
		numberOfReadings: r.numberOfReadings,
		stageCheck: r.stageCheck ?? null,
		background: r.background ?? null,
		// Per-channel clear vs reading number for a quick empty-slot trace.
		trace: ['A', 'B', 'C'].map((ch) => ({ ch, pts: (r.readings ?? []).filter((x: any) => x.channel === ch).map((x: any) => [x.number, x.clear, x.f3, x.f7, x.laser_output]) }))
	}));
	return { session: JSON.parse(JSON.stringify(session)), records: JSON.parse(JSON.stringify(records)) };
};
