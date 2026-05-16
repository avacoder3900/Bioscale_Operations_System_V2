/**
 * /capture — dedicated capture station.
 *
 * Hardware-scanner-first flow: operator scans a cartridge with a USB scanner
 * (HID keyboard wedge mode), the scanned ID becomes the sticky context, and
 * subsequent photos are auto-tagged with that cartridge until the next scan.
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import type { PageServerLoad } from './$types';

const DEFAULT_PHASES = [
	'wax_filled',
	'reagent_filled',
	'inspected',
	'sealed',
	'oven_cured',
	'qaqc_released',
	'post_run'
];

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Pull the phases we actually have data for, union with the standard list.
	const distinctPhases = await CvImage.distinct('cartridgeTag.phase');
	const phases = Array.from(new Set([...DEFAULT_PHASES, ...(distinctPhases as string[]).filter(Boolean)])).sort();

	return {
		phases,
		user: { _id: locals.user._id, username: locals.user.username }
	};
};

export const config = { maxDuration: 60 };
