import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, KanbanTask } from '$lib/server/db';
import { getKanbanPolicy } from '$lib/server/kanban/policy';
import { businessDaysBetween } from '$lib/server/kanban/schedule';
import { SIZE_CLASS_DAYS } from '$lib/shared/kanban-status';
import type { RequestHandler } from './$types';

/**
 * KB2-32 — kanban_velocity_report: the speedometer's homework. Everything the
 * agent needs to EXPLAIN a projection instead of trusting one opaque number:
 * the trailing-window completion list (with which field was counted), weekly
 * buckets, measured velocity, sample size, the velocitySource decision trace,
 * and calibration over the same field the clamp consumes.
 */
const DAY_MS = 24 * 60 * 60 * 1000;

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const policy: any = await getKanbanPolicy().catch(() => null);
	const cap = policy?.capacity ?? {};
	const blendMinN: number = cap.blendMinN ?? 8;
	const measuredMinN: number = cap.measuredMinN ?? 15;
	const trailingWindowWeeks: number = cap.trailingWindowWeeks ?? 6;
	const knob: number | null =
		typeof cap.teamEstDaysPerWeek === 'number' && cap.teamEstDaysPerWeek > 0
			? cap.teamEstDaysPerWeek
			: null;

	const today = new Date(); today.setHours(0, 0, 0, 0);
	const since = new Date(today.getTime() - trailingWindowWeeks * 7 * DAY_MS);
	const done = (await KanbanTask.find({ status: 'done', completedDate: { $gte: since } })
		.select('_id trackingNumber title sizeClass estimateDays effortDays wipDate completedDate')
		.sort({ completedDate: -1 })
		.lean()) as any[];

	const counted = (t: any): { days: number; source: string } => {
		if (typeof t.effortDays === 'number' && t.effortDays > 0) return { days: t.effortDays, source: 'effortDays' };
		if (typeof t.estimateDays === 'number' && t.estimateDays > 0) return { days: t.estimateDays, source: 'estimateDays' };
		if (t.sizeClass && (SIZE_CLASS_DAYS as any)[t.sizeClass] != null)
			return { days: (SIZE_CLASS_DAYS as any)[t.sizeClass], source: 'sizeClass' };
		return { days: 1, source: 'median-fallback' };
	};

	const completions = done.map((t) => {
		const c = counted(t);
		const actual =
			t.wipDate && t.completedDate
				? Math.max(0.5, businessDaysBetween(new Date(t.wipDate), new Date(t.completedDate)))
				: null;
		return {
			taskId: String(t._id),
			trackingNumber: t.trackingNumber ?? null,
			title: t.title,
			completedAt: t.completedDate,
			estimateDays: t.estimateDays ?? null,
			effortDays: t.effortDays ?? null,
			countedDays: c.days,
			countedFrom: c.source,
			actualBusinessDays: actual
		};
	});

	// weekly buckets (0 = current week)
	const weekly: { weeksAgo: number; totalDays: number; tasks: number }[] = Array.from(
		{ length: trailingWindowWeeks },
		(_, i) => ({ weeksAgo: i, totalDays: 0, tasks: 0 })
	);
	for (const c of completions) {
		const weeksAgo = Math.floor((today.getTime() - new Date(c.completedAt).setHours(0, 0, 0, 0)) / (7 * DAY_MS));
		if (weeksAgo >= 0 && weeksAgo < trailingWindowWeeks) {
			weekly[weeksAgo].totalDays += c.countedDays;
			weekly[weeksAgo].tasks += 1;
		}
	}
	const trailingTotal = weekly.reduce((s, w) => s + w.totalDays, 0);
	const measuredVelocity = trailingTotal > 0 ? trailingTotal / trailingWindowWeeks : null;

	const estimated = completions.filter((c) => c.countedFrom === 'effortDays' || c.countedFrom === 'estimateDays');
	const n = estimated.length;

	let velocitySource: 'policy' | 'blend' | 'measured';
	let effectiveVelocity: number | null;
	if (knob === null) { velocitySource = 'measured'; effectiveVelocity = measuredVelocity; }
	else if (n >= measuredMinN && measuredVelocity !== null) { velocitySource = 'measured'; effectiveVelocity = measuredVelocity; }
	else if (n >= blendMinN && measuredVelocity !== null) {
		velocitySource = 'blend';
		effectiveVelocity = measuredVelocity * (n / measuredMinN) + knob * (1 - n / measuredMinN);
	} else { velocitySource = 'policy'; effectiveVelocity = knob; }

	const ratios = estimated
		.filter((c) => c.actualBusinessDays !== null)
		.map((c) => c.actualBusinessDays! / c.countedDays)
		.sort((a, b) => a - b);
	const medianRatio = ratios.length
		? ratios.length % 2
			? ratios[Math.floor(ratios.length / 2)]
			: (ratios[ratios.length / 2 - 1] + ratios[ratios.length / 2]) / 2
		: null;

	return json({
		success: true,
		data: {
			window: { weeks: trailingWindowWeeks, since: since.toISOString().slice(0, 10) },
			policy: { teamEstDaysPerWeek: knob, blendMinN, measuredMinN, schedule: cap.schedule ?? [] },
			completions,
			weeklyBuckets: weekly,
			measuredVelocityDaysPerWeek: measuredVelocity,
			estimatedSampleN: n,
			decision: {
				velocitySource,
				effectiveVelocityDaysPerWeek: effectiveVelocity,
				explanation:
					knob === null
						? 'No capacity knob set — legacy measured-only mode (note: kanban_roadmap uses an 8-week ladder-valued mean in this mode).'
						: n >= measuredMinN
							? `n=${n} ≥ measuredMinN=${measuredMinN} → trailing measured velocity wins.`
							: n >= blendMinN
								? `blendMinN=${blendMinN} ≤ n=${n} < measuredMinN=${measuredMinN} → blend: measured·${n}/${measuredMinN} + policy·${(1 - n / measuredMinN).toFixed(2)}.`
								: `n=${n} < blendMinN=${blendMinN} → policy knob (${knob}/wk) wins until the board accrues real completions.`
			},
			calibration: { n: ratios.length, medianActualOverEstimate: medianRatio }
		}
	});
};
