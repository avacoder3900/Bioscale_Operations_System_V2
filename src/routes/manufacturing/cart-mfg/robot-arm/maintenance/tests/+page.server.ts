/**
 * Maintenance → Tests (2026-11-06): the physical tests from
 * $lib/robot-arm/arm-tests, run one at a time against the real arm, with the
 * newest result per test and the Test Log. Above them, the newest run of the
 * automated unit tests (scripts/report-arm-unit-tests.ts), which also shows
 * in the Test Log. A run is logged whatever it finds
 * (robot_arm_test_runs + a test.* change row).
 */
import { fail, redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { ARM_TESTS } from '$lib/robot-arm/arm-tests';
import { latestArmTestRuns, listArmTestRuns, listArmUnitRuns, runArmTest, unitRunLogRow, type ArmTestRunRow, type ArmUnitRunRow } from '$lib/server/robot-arm-tests';
import type { Actions, PageServerLoad } from './$types';

// The longest tests (repeatability, return to home) drive the arm for over a minute.
export const config = { maxDuration: 120 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	let latest: Record<string, ArmTestRunRow> = {};
	let runs: ArmTestRunRow[] = [];
	let unit: ArmUnitRunRow | null = null;
	let logError: string | null = null;
	try {
		let unitRuns: ArmUnitRunRow[];
		[latest, runs, unitRuns] = await Promise.all([latestArmTestRuns(), listArmTestRuns({ limit: 200 }), listArmUnitRuns({ limit: 50 })]);
		// The Test Log holds both: physical runs and the automated unit runs, newest first.
		unit = unitRuns[0] ?? null;
		runs = [...runs, ...unitRuns.map(unitRunLogRow)].sort((a, b) => b.at.localeCompare(a.at));
	} catch (err) {
		logError = err instanceof Error ? err.message : String(err);
	}
	return { tests: ARM_TESTS, latest, runs, unit, logError, canRun: hasPermission(locals.user, 'manufacturing:write') };
};

export const actions: Actions = {
	run: async ({ request, locals }) => {
		if (!locals.user) return fail(401, { error: 'Unauthorized' });
		requirePermission(locals.user, 'manufacturing:write');
		const d = await request.formData();
		const key = d.get('key')?.toString() ?? '';
		try {
			const result = await runArmTest({ _id: locals.user._id, username: locals.user.username }, key);
			return { result };
		} catch (err) {
			return fail(400, { error: err instanceof Error ? err.message : String(err) });
		}
	}
};
