import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { sectionLabel } from '$lib/server/services/device-assembly-wi';
import { RefError, requireWI, resolveSection, resolveStep, stepView, stockIndex } from '$lib/server/services/device-assembly-wi-agent';
import type { RequestHandler } from './$types';

/**
 * GET /api/agent/device-assembly/step
 *   ?section=2&step=3        → full detail of one step
 *   ?stepId=<id>             → same, by id
 *   ?section=2               → every step of a section in full
 *   ?q=heater block          → search step titles/instructions/materials across all sections
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();
	try {
		const wi = await requireWI();
		const stock = await stockIndex(wi);
		const q = url.searchParams.get('q');
		const stepId = url.searchParams.get('stepId');
		const section = url.searchParams.get('section');
		const step = url.searchParams.get('step');

		if (stepId) {
			const r = resolveStep(wi, null, stepId);
			return json({ success: true, data: stepView(r.section, r.step, stock, { full: true }) });
		}
		if (section && step) {
			const r = resolveStep(wi, section, step);
			return json({ success: true, data: stepView(r.section, r.step, stock, { full: true }) });
		}
		if (section) {
			const s = resolveSection(wi, section);
			return json({ success: true, data: { section: sectionLabel(s), sectionNumber: s.number, title: s.title, notesText: (s.notesHtml || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || undefined, steps: s.steps.map((st: any) => stepView(s, st, stock, { full: true })) } });
		}
		if (q) {
			const needle = q.toLowerCase();
			const hits: any[] = [];
			for (const s of wi.sections) {
				for (const st of s.steps) {
					const hay = [st.title, st.instructionsText, ...(st.materials ?? []).map((m: any) => `${m.name} ${m.partNumber ?? ''}`)].join(' ').toLowerCase();
					if (hay.includes(needle)) hits.push(stepView(s, st, stock));
				}
			}
			return json({ success: true, data: { query: q, matches: hits } });
		}
		throw error(400, 'Provide stepId, section (+ step), or q');
	} catch (e: any) {
		if (e instanceof RefError) throw error(404, e.message);
		throw e;
	}
};
