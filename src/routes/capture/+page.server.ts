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
import { CaptureStation } from '$lib/server/db/models/capture-station.js';
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

	// Online Pi capture stations for the station dropdown. Token is never sent
	// to the page payload — operator fetches it on demand via /api/cv/stations/[id]/token.
	const stations = await CaptureStation.find({ status: 'online' })
		.select('_id name hostname capabilities mode assignedPhase')
		.sort({ name: 1 })
		.lean();

	return {
		phases,
		stations: JSON.parse(JSON.stringify(stations)),
		user: { _id: locals.user._id, username: locals.user.username }
	};
};

export const config = { maxDuration: 60 };
