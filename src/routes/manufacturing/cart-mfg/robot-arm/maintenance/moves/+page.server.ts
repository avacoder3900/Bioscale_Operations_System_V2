import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { listArmMoves, type ArmMoveRow } from '$lib/server/robot-arm-move-log';
import { summarizeServoMoves, type ServoMoveSummary } from '$lib/robot-arm/move-log';
import type { PageServerLoad } from './$types';

/** Window choices, in minutes; 0 = all. */
const WINDOWS = [60, 1440, 10080, 0];
const LIMIT = 2000;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const w = Number(url.searchParams.get('minutes'));
	const minutes = WINDOWS.includes(w) ? w : 60;
	const s = Number(url.searchParams.get('servo'));
	const servo = Number.isInteger(s) && s >= 1 && s <= 6 ? s : null;
	// The Movement Log (2026-11-06). A read failure shows as a line, never a 500.
	let moves: ArmMoveRow[] = [];
	let summary: ServoMoveSummary[] = [];
	let movesError: string | null = null;
	let capped = false;
	try {
		const all = await listArmMoves({ sinceMinutes: minutes, limit: LIMIT });
		capped = all.length >= LIMIT;
		summary = summarizeServoMoves(all);
		moves = servo ? all.filter((m) => m.servo === servo || (m.goals && String(servo) in m.goals) || (m.servo == null && !m.goals)) : all;
	} catch (err) {
		movesError = err instanceof Error ? err.message : String(err);
	}
	return { moves, summary, movesError, capped, limit: LIMIT, minutes, servo };
};
