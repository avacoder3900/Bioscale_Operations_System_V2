/**
 * /cv/forensic-capture — R&D forensic capture flow.
 *
 * Identical UX to /capture, but phase is locked to 'post_run' and operators
 * can attach an optional runId / sessionId so the image can later be tied
 * back to a test run for failure analysis. These photos are NOT manufacturing
 * QC — they're forensic evidence captured after a cartridge has been run.
 */
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	return {
		user: { _id: locals.user._id, username: locals.user.username }
	};
};

export const config = { maxDuration: 60 };
