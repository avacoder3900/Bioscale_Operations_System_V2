import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ArmWaxFillSettings } from '$lib/server/db';
import { listArmMoves, type ArmMoveRow } from '$lib/server/robot-arm-move-log';
import { syncOt2Robot, type Ot2SyncResult } from '$lib/server/ot2-move-log';
import { summarizeServoMoves, type ServoMoveSummary } from '$lib/robot-arm/move-log';
import { summarizeTiming, type TimingRow } from '$lib/robot-arm/ot2-move-log';
import type { PageServerLoad } from './$types';

/** Window choices, in minutes; 0 = all. */
const WINDOWS = [60, 1440, 10080, 0];
const LIMIT = 2000;
const DEVICES = ['arm', 'ot2'] as const;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const w = Number(url.searchParams.get('minutes'));
	const minutes = WINDOWS.includes(w) ? w : 60;
	const s = Number(url.searchParams.get('servo'));
	const servo = Number.isInteger(s) && s >= 1 && s <= 6 ? s : null;
	const d = url.searchParams.get('device');
	const device = servo ? 'arm' : (DEVICES as readonly string[]).includes(d ?? '') ? (d as 'arm' | 'ot2') : null;
	// The Movement Log (2026-11-06). A read failure shows as a line, never a 500.
	let moves: ArmMoveRow[] = [];
	let summary: ServoMoveSummary[] = [];
	let timing: TimingRow[] = [];
	let movesError: string | null = null;
	let capped = false;
	// The arm line's OT-2: its new commands are read in first, within a few seconds.
	let ot2: Ot2SyncResult | null = null;
	try {
		await connectDB();
		const settings = (await ArmWaxFillSettings.findById('default').select('robotId').lean()) as { robotId?: string } | null;
		if (settings?.robotId && device !== 'arm') ot2 = await syncOt2Robot(settings.robotId, { budgetMs: 6000 });
		const all = await listArmMoves({ sinceMinutes: minutes, device, limit: LIMIT });
		capped = all.length >= LIMIT;
		summary = summarizeServoMoves(all);
		timing = summarizeTiming(all);
		moves = servo ? all.filter((m) => m.servo === servo || (m.goals && String(servo) in m.goals) || (m.servo == null && !m.goals)) : all;
	} catch (err) {
		movesError = err instanceof Error ? err.message : String(err);
	}
	return { moves, summary, timing, ot2, movesError, capped, limit: LIMIT, minutes, servo, device };
};
