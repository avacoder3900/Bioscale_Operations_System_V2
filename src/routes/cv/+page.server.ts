import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

/**
 * /cv — landing redirect. After the cartridge-first refactor, the CV section's
 * "home" is the chronological image stream. From there operators branch into
 * /cv/label, /cv/projects, or /capture.
 */
export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	redirect(302, '/cv/stream');
};
