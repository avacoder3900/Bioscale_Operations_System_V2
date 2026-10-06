import { json } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { getDeviceAssemblyWI } from '$lib/server/services/device-assembly-wi';
import { revisionView } from '$lib/server/services/device-assembly-wi-agent';
import type { RequestHandler } from './$types';

/** GET /api/agent/device-assembly/revisions?limit=&user=&section=&step=&since=&detail=1 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	const wi = await getDeviceAssemblyWI();
	if (!wi) return json({ success: true, data: null, message: 'No Device Assembly Work Instruction has been imported yet.' });
	const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
	const user = url.searchParams.get('user')?.toLowerCase();
	const section = url.searchParams.get('section');
	const step = url.searchParams.get('step');
	const since = url.searchParams.get('since');
	const detail = url.searchParams.get('detail') === '1';
	let rows = [...wi.revisions].sort((a: any, b: any) => b.version - a.version);
	if (user) rows = rows.filter((r: any) => (r.changedBy?.username ?? '').toLowerCase() === user);
	if (section != null && section !== '') rows = rows.filter((r: any) => String(r.location?.sectionNumber) === String(section).replace(/\D/g, ''));
	if (step) rows = rows.filter((r: any) => String(r.location?.stepNumber) === step);
	if (since) { const t = new Date(since).getTime(); if (Number.isFinite(t)) rows = rows.filter((r: any) => new Date(r.changedAt).getTime() >= t); }
	const data = rows.slice(0, limit).map(revisionView).map((r) => (detail ? r : { ...r, before: undefined, after: undefined }));
	return json({ success: true, data: { currentVersion: wi.currentVersion, total: wi.revisions.length, revisions: data } });
};
