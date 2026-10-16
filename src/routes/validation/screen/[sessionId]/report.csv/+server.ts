import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import { loadScreenCriteria } from '$lib/server/screen/ingest';
import { summarizeSession } from '$lib/server/screen/summarize';
import type { RequestHandler } from './$types';

/** The full report of ONE screen as CSV: every row in emission order, with what it measures and the rule. */
export const GET: RequestHandler = async ({ params, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const s = (await ValidationSession.findById(params.sessionId).lean()) as any;
	if (!s || s.type !== 'screen') throw error(404, 'Screen session not found');
	const h = summarizeSession(s, await loadScreenCriteria());
	const esc = (v: unknown) => {
		const t = v == null ? '' : String(v);
		return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
	};
	const lines = ['seq,level,test,id,rep,status,device_status,value,limit,ms,note,what_it_measures,rule'];
	for (const r of h.rows) {
		lines.push([r.seq, r.level, r.label, r.id, r.rep, r.status, r.deviceStatus, r.value, r.limit, r.ms, r.note, r.what, r.rule].map(esc).join(','));
	}
	const head = [
		`# screen ${h.id} · ${h.spuUdi ?? h.particleDeviceId} · fw ${h.fw} · run ${h.run} · started ${h.startedAt} · ${h.complete ? (h.overallPassed ? 'PASS' : 'FAIL') : 'running'}`,
		`# ${h.counts.pass} pass · ${h.counts.fail} fail · ${h.counts.warn} warn · ${h.counts.skip} skip · ${h.counts.info} info`,
		h.review ? `# reviewed ${h.review.verdict} by ${h.review.by?.username ?? '?'} at ${h.review.at}${h.review.notes ? ' — ' + h.review.notes.replace(/\n/g, ' ') : ''}` : '# not yet reviewed'
	];
	return new Response(head.join('\n') + '\n' + lines.join('\n') + '\n', {
		headers: {
			'content-type': 'text/csv; charset=utf-8',
			'content-disposition': `attachment; filename="screen-${h.spuUdi ?? h.particleDeviceId}-run${h.run}.csv"`
		}
	});
};
