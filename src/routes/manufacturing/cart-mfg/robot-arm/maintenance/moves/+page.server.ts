import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { countArmMoves, listArmMoves, listMoveKinds, type ArmMoveRow } from '$lib/server/robot-arm-move-log';
import { syncOt2Robot, type Ot2SyncResult } from '$lib/server/ot2-move-log';
import { summarizeServoMoves, type ServoMoveSummary } from '$lib/robot-arm/move-log';
import { moveGroup } from '$lib/robot-arm/move-types';
import { summarizeTiming, type TimingRow } from '$lib/robot-arm/ot2-move-log';
import type { PageServerLoad } from './$types';

/** Window choices, in minutes; 0 = all time. */
const WINDOWS = [60, 1440, 10080, 0];
const DEVICES = ['arm', 'ot2', 'link'] as const;
/** Newest rows shown unless another number or All is picked. */
const DEFAULT_COUNT = 100;

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	const w = Number(url.searchParams.get('minutes') ?? 0);
	const minutes = WINDOWS.includes(w) ? w : 0;
	const s = Number(url.searchParams.get('servo'));
	const servo = Number.isInteger(s) && s >= 1 && s <= 6 ? s : null;
	const kind = url.searchParams.get('kind')?.slice(0, 80) || null;
	const group = moveGroup(url.searchParams.get('group'))?.id ?? null;
	const d = url.searchParams.get('device');
	const device: 'arm' | 'ot2' | 'link' | null = servo
		? 'arm'
		: (DEVICES as readonly string[]).includes(d ?? '')
			? (d as 'arm' | 'ot2' | 'link')
			: (moveGroup(group)?.device ?? null);
	const n = url.searchParams.get('n');
	const nn = Number(n);
	const count: number | 'all' = n === 'all' ? 'all' : Number.isInteger(nn) && nn >= 1 ? nn : DEFAULT_COUNT;
	const filter = { sinceMinutes: minutes, servo, device, group, kind };
	// The Movement Log (2026-11-06). A read failure shows as a line, never a 500.
	let moves: ArmMoveRow[] = [];
	let total = 0;
	let kinds: { device: 'arm' | 'ot2' | 'link'; kind: string; count: number }[] = [];
	let summary: ServoMoveSummary[] = [];
	let timing: TimingRow[] = [];
	let movesError: string | null = null;
	// Every active OT-2's new commands are read in first, side by side, within a few seconds.
	let ot2: Ot2SyncResult[] = [];
	try {
		await connectDB();
		if (device !== 'arm') {
			const robots = (await OpentronsRobot.find({ isActive: { $ne: false } }).select('_id').lean()) as { _id: string }[];
			ot2 = await Promise.all(robots.map((r) => syncOt2Robot(String(r._id), { budgetMs: 6000 })));
		}
		[moves, total, kinds] = await Promise.all([
			listArmMoves({ ...filter, limit: count === 'all' ? null : count }),
			countArmMoves(filter),
			listMoveKinds()
		]);
		summary = summarizeServoMoves(moves);
		timing = summarizeTiming(moves);
	} catch (err) {
		movesError = err instanceof Error ? err.message : String(err);
	}
	return { moves, total, kinds, summary, timing, ot2, movesError, minutes, servo, device, group, kind, count };
};
