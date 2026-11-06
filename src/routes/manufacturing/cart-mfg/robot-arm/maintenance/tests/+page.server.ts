/**
 * Maintenance → Tests (2026-11-06): the physical tests from
 * $lib/robot-arm/arm-tests, run one at a time against the real arm, with the
 * newest result per test and the Test Log. A run is logged whatever it finds
 * (robot_arm_test_runs + a test.* change row).
 */
import { fail, redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { ARM_TESTS } from '$lib/robot-arm/arm-tests';
import { latestArmTestRuns, listArmTestRuns, runArmTest, type ArmTestRunRow } from '$lib/server/robot-arm-tests';
import { listMoveSets } from '$lib/server/robot-arm-animation';
import type { Actions, PageServerLoad } from './$types';

// The longest tests (repeatability, return to home, a replay) drive the arm for over a minute.
export const config = { maxDuration: 120 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	let latest: Record<string, ArmTestRunRow> = {};
	let runs: ArmTestRunRow[] = [];
	let moveSets: { _id: string; name: string }[] = [];
	let logError: string | null = null;
	try {
		[latest, runs] = await Promise.all([latestArmTestRuns(), listArmTestRuns({ limit: 200 })]);
	} catch (err) {
		logError = err instanceof Error ? err.message : String(err);
	}
	try {
		moveSets = (await listMoveSets()).filter((m) => !m.archived).map((m) => ({ _id: m._id, name: m.name }));
	} catch {
		moveSets = [];
	}
	return { tests: ARM_TESTS, latest, runs, moveSets, logError, canRun: hasPermission(locals.user, 'manufacturing:write') };
};

export const actions: Actions = {
	run: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const key = d.get('key')?.toString() ?? '';
		const moveSetId = d.get('moveSetId')?.toString() || null;
		try {
			const result = await runArmTest({ _id: locals.user._id, username: locals.user.username }, key, { moveSetId });
			return { result };
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}
	}
};
