import { redirect } from '@sveltejs/kit';
import { connectDB, ReagentBatchRecord, OpentronsRobot } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const config = { maxDuration: 60 };

/**
 * Reagent well-issue history (2026-10-06). Every mistake logged on the run-page
 * well tracker, rolled up by robot + deck into a 24-position × 4-well heatmap,
 * plus the per-run list. The point: calibration looks right in the Studio and
 * the fills still miss "here and there" — if the misses pile up on one position
 * or one carrier, that is a deck/geometry problem; if they are random, it is the
 * tip. Only runs that have at least one issue are listed; the run count in the
 * header is ALL runs in the window so the rate is honest.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const days = Math.min(365, Math.max(1, Number(url.searchParams.get('days') ?? 30) || 30));
	const robotFilter = url.searchParams.get('robot') ?? '';
	const since = new Date(Date.now() - days * 86_400_000);

	const robots = (await OpentronsRobot.find({}).select('_id name').lean()) as any[];
	const robotName = new Map(robots.map((r) => [String(r._id), String(r.name ?? r._id)]));

	const q: Record<string, unknown> = { createdAt: { $gte: since } };
	if (robotFilter) q['robot._id'] = robotFilter;
	const runs = (await ReagentBatchRecord.find(q)
		.select('_id robot deckId status createdAt runStartTime cartridgeCount cartridgesFilled wellIssues assayType isResearch operator')
		.sort({ createdAt: -1 })
		.lean()) as any[];

	type Cell = { count: number; byIssue: Record<string, number> };
	const groups = new Map<string, {
		robotId: string; robotName: string; deckId: string;
		runs: number; runsWithIssues: number; cartsFilled: number; issues: number;
		cells: Record<string, Cell>; // "pos:well"
		byIssue: Record<string, number>;
	}>();

	const runRows: any[] = [];
	for (const r of runs) {
		const rid = String(r.robot?._id ?? '');
		const rname = r.robot?.name && robotName.get(rid) ? robotName.get(rid)! : (robotName.get(rid) ?? r.robot?.name ?? rid);
		const deck = String(r.deckId ?? '—');
		const key = `${rid}|${deck}`;
		if (!groups.has(key)) {
			groups.set(key, { robotId: rid, robotName: rname, deckId: deck, runs: 0, runsWithIssues: 0, cartsFilled: 0, issues: 0, cells: {}, byIssue: {} });
		}
		const g = groups.get(key)!;
		g.runs += 1;
		g.cartsFilled += Number(r.cartridgeCount ?? r.cartridgesFilled?.length ?? 0);
		const issues: any[] = r.wellIssues ?? [];
		if (issues.length) {
			g.runsWithIssues += 1;
			g.issues += issues.length;
			for (const w of issues) {
				const ck = `${w.deckPosition}:${w.well}`;
				const cell = (g.cells[ck] ??= { count: 0, byIssue: {} });
				cell.count += 1;
				cell.byIssue[w.issue] = (cell.byIssue[w.issue] ?? 0) + 1;
				g.byIssue[w.issue] = (g.byIssue[w.issue] ?? 0) + 1;
			}
			runRows.push({
				id: String(r._id),
				robotName: rname,
				deckId: deck,
				status: r.status ?? null,
				startedAt: (r.runStartTime ?? r.createdAt) ? new Date(r.runStartTime ?? r.createdAt).toISOString() : null,
				assay: r.isResearch ? 'Research' : (r.assayType?.name ?? null),
				operator: r.operator?.username ?? null,
				cartridgeCount: Number(r.cartridgeCount ?? r.cartridgesFilled?.length ?? 0),
				issues: issues.map((w) => ({
					deckPosition: Number(w.deckPosition),
					well: Number(w.well),
					reagentName: w.reagentName ?? null,
					issue: String(w.issue),
					note: w.note ?? null,
					loggedBy: w.loggedBy?.username ?? null,
					loggedAt: w.loggedAt ? new Date(w.loggedAt).toISOString() : null
				}))
			});
		}
	}

	return {
		days,
		robotFilter,
		robots: robots.map((r) => ({ id: String(r._id), name: String(r.name ?? r._id) })),
		groups: [...groups.values()].sort((a, b) => b.issues - a.issues || a.robotName.localeCompare(b.robotName)),
		runs: runRows,
		totalRuns: runs.length
	};
};
