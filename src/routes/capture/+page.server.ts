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
import { CvProject } from '$lib/server/db/models/cv-project.js';
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

export const load: PageServerLoad = async ({ locals, url }) => {
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

	// Optional deep-link context: arriving from /cv/projects/[id] via the
	// "Capture cartridges →" button. ?phase= preselects the phase dropdown,
	// ?projectId= drives the project-context banner that tells the operator
	// whether inference will actually run for their captures.
	const requestedPhase = url.searchParams.get('phase');
	const initialPhase = requestedPhase && phases.includes(requestedPhase)
		? requestedPhase
		: phases.includes('wax_filled') ? 'wax_filled' : (phases[0] ?? 'wax_filled');

	const requestedProjectId = url.searchParams.get('projectId');
	let projectContext: {
		id: string;
		name: string;
		deployAtPhases: string[];
		activeModelVersion: string | null;
	} | null = null;
	if (requestedProjectId) {
		const proj = await CvProject.findById(requestedProjectId)
			.select('_id name deployAtPhases activeModelVersion')
			.lean() as any;
		if (proj) {
			projectContext = {
				id: proj._id,
				name: proj.name ?? '',
				deployAtPhases: proj.deployAtPhases ?? [],
				activeModelVersion: proj.activeModelVersion ?? null
			};
		}
	}

	// Phase → deployed-projects map. Drives the always-on inference indicator
	// so the operator can see — BEFORE they capture — whether the currently
	// selected phase has any model wired up. Empty array for a phase means
	// captures at that phase will write CvImage rows but no CvInspection rows.
	const allDeployed = await CvProject.find({
		activeModelVersion: { $ne: null },
		deployAtPhases: { $exists: true, $not: { $size: 0 } }
	}).select('_id name activeModelVersion deployAtPhases').lean() as any[];

	const deploymentsByPhase: Record<string, Array<{ id: string; name: string; version: string }>> = {};
	for (const p of allDeployed) {
		for (const ph of p.deployAtPhases ?? []) {
			(deploymentsByPhase[ph] ??= []).push({
				id: p._id,
				name: p.name ?? '(unnamed project)',
				version: p.activeModelVersion
			});
		}
	}

	return {
		phases,
		stations: JSON.parse(JSON.stringify(stations)),
		user: { _id: locals.user._id, username: locals.user.username },
		initialPhase,
		projectContext,
		deploymentsByPhase
	};
};

export const config = { maxDuration: 60 };
