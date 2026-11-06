import { redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { listArmChanges, type ArmChangeRow } from '$lib/server/robot-arm-change-log';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	// The Change Log (2026-11-06): newest first. A read failure shows as a line, never a 500.
	let changes: ArmChangeRow[] = [];
	let changesError: string | null = null;
	try {
		changes = await listArmChanges({ limit: 200 });
	} catch (err) {
		changesError = err instanceof Error ? err.message : String(err);
	}
	return { changes, changesError };
};
