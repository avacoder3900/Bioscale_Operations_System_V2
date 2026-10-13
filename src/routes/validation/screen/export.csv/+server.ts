import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { loadScreenCriteria } from '$lib/server/screen/ingest';
import { summarizeSession } from '$lib/server/screen/summarize';
import type { RequestHandler } from './$types';

/** Every screen row as CSV: one line per (session, test). ?udi= narrows to a unit. */
export const GET: RequestHandler = async ({ locals, url }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const udi = url.searchParams.get('udi')?.trim() || null;
	const q: Record<string, unknown> = { type: 'screen' };
	if (udi) q.spuUdi = udi;
	const criteria = await loadScreenCriteria();
	const sessions = (await ValidationSession.find(q).sort({ startedAt: -1 }).limit(500).lean()) as any[];
	const esc = (v: unknown) => {
		const s = v == null ? '' : String(v);
		return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
	};
	const lines = ['session_id,spu_udi,started_at,fw,run,complete,overall_passed,level,test_id,test_label,status,device_status,value,limit,ms,note'];
	for (const s of sessions) {
		const h = summarizeSession(s, criteria);
		for (const r of h.rows) {
			lines.push([h.id, h.spuUdi, h.startedAt, h.fw, h.run, h.complete, h.overallPassed, r.level, r.id, r.label, r.status, r.deviceStatus, r.value, r.limit, r.ms, r.note].map(esc).join(','));
		}
	}
	return new Response(lines.join('\n') + '\n', {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="screen${udi ? '-' + udi : ''}.csv"`
		}
	});
};
