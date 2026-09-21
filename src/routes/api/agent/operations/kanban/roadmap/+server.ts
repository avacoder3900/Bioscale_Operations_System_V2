import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { computeRoadmap, type CapacityOverrides } from '$lib/server/kanban/schedule';
import type { RequestHandler } from './$types';

/**
 * KB2-28 — the derived roadmap (kanban_roadmap). Recomputed fresh per call:
 * CPM backward/forward pass per dated milestone + capacity clamp, slack,
 * critical chain, must-start list, buffer burn, calibration. All dates in the
 * result are OUTPUTS — nothing here is ever written to tasks.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);

	// KB2-31/32 what-ifs — applied to THIS computation only, never persisted.
	const overrides: CapacityOverrides = {};
	const capRaw = url.searchParams.get('capacityOverride');
	if (capRaw !== null) {
		const n = parseFloat(capRaw);
		if (!Number.isFinite(n) || n <= 0) throw error(400, 'capacityOverride must be a positive number');
		overrides.capacityOverride = n;
	}
	const schedRaw = url.searchParams.get('scheduleOverride');
	if (schedRaw) {
		let parsed: any;
		try { parsed = JSON.parse(schedRaw); } catch { throw error(400, 'scheduleOverride must be JSON'); }
		if (!Array.isArray(parsed)) throw error(400, 'scheduleOverride must be an array');
		for (const e of parsed) {
			if (!e?.from || isNaN(new Date(e.from).getTime()) || !(typeof e.teamEstDaysPerWeek === 'number' && e.teamEstDaysPerWeek > 0)) {
				throw error(400, 'scheduleOverride entries need { from: ISO date, teamEstDaysPerWeek: > 0 }');
			}
		}
		overrides.scheduleOverride = parsed;
	}

	const data = await computeRoadmap(new Date(), overrides);
	return json({ success: true, data });
};
