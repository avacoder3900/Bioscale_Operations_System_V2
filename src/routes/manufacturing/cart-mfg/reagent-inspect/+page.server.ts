/**
 * /manufacturing/cart-mfg/reagent-inspect — inline CV deployment point
 * (REAGENT-INSPECT-AFTER-TOPSEAL, REAGENT-TOPSEAL-IMPLICIT).
 *
 * Runs after reagent fill + the implicit top seal: every reagent_filled
 * cartridge gets photographed here (→ reagent_qc) and the deployed model's
 * verdict is shown immediately. Mirror of /wax-inspect, pinned
 * to the 'reagent_filled' phase: same scanner-wedge sticky context, same
 * Pi-station WebRTC + USB-camera capture paths, same POST /api/cv/capture →
 * poll /api/cv/inspections round-trip. The scan-gated human verdict moves a
 * cart reagent_qc → reagent_ready | reagent_rejected via /api/cv/reagent-verdict.
 *
 * Server load supplies:
 *   - stations:          all CaptureStations (status-badged; tokens fetched on demand)
 *   - modelDeployed:     does ANY CvProject deploy at 'reagent_filled' with an active model?
 *   - deployedProjects:  name/version of those projects for the header display
 *   - recentInspections: last 50 reagent_filled CvInspections joined with CvImage thumbnails
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation, deriveStatus } from '$lib/server/db/models/capture-station.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CvImage } from '$lib/server/db/models/cv-image.js';
import { getR2Url } from '$lib/server/services/r2';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

const PHASE = 'reagent_filled';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Pi capture stations for the station dropdown — mirror of /capture's load.
	// Return ALL stations (not just online) so the operator can see why an
	// option is unavailable; the dropdown disables offline/held entries.
	// Tokens are never sent — fetched on demand via /api/cv/stations/[id]/token.
	const stationsRaw = await CaptureStation.find()
		.select(
			'_id name hostname capabilities mode assignedPhase status lastSeenAt currentOperator'
		)
		.sort({ name: 1 })
		.lean();
	const stations = (stationsRaw as any[]).map((s: any) => ({
		...s,
		status: deriveStatus(s),
		currentOperator: s.currentOperator
			? {
					_id: s.currentOperator._id ?? null,
					username: s.currentOperator.username ?? null,
					since: s.currentOperator.since ?? null
				}
			: null
	}));

	// Is anything actually deployed at reagent_filled? Drives the yellow
	// "captures will save without inference" notice when nothing is.
	const deployedRaw = await CvProject.find({
		deployAtPhases: PHASE,
		activeModelVersion: { $ne: null }
	})
		.select('_id name activeModelVersion')
		.lean() as any[];
	const deployedProjects = deployedRaw.map((p: any) => ({
		id: p._id,
		name: p.name ?? '(unnamed project)',
		version: p.activeModelVersion
	}));

	// Last 50 reagent_filled inspections (newest first), joined with their CvImage
	// for thumbnail + operator. Shadow inspections are included but flagged so
	// the UI can caption them instead of presenting them as operator verdicts.
	const inspectionsRaw = await CvInspection.find({ phase: PHASE })
		.sort({ createdAt: -1 })
		.limit(50)
		.lean() as any[];

	const imageIds = Array.from(
		new Set(inspectionsRaw.map((i: any) => i.imageId).filter(Boolean))
	);
	const images = imageIds.length > 0
		? await CvImage.find({ _id: { $in: imageIds } })
			.select('_id imageUrl filePath capturedBy')
			.lean() as any[]
		: [];
	const imageById = new Map<string, any>(images.map((img: any) => [img._id, img]));

	const recentInspections = inspectionsRaw.map((i: any) => {
		const img = i.imageId ? imageById.get(i.imageId) : undefined;
		return {
			id: i._id,
			imageId: i.imageId ?? null,
			cartridgeRecordId: i.cartridgeRecordId ?? null,
			imageUrl: img?.imageUrl ?? (img?.filePath ? getR2Url(img.filePath) : null),
			result: i.result ?? null,
			confidenceScore: typeof i.confidenceScore === 'number' ? i.confidenceScore : null,
			modelVersion: i.modelVersion ?? null,
			status: i.status ?? null,
			isShadow: i.isShadow === true,
			// run-inference stamps triggeredAt; older/manual rows fall back to createdAt
			triggeredAt: i.triggeredAt ?? i.createdAt ?? null,
			operator: img?.capturedBy?.username ?? null
		};
	});

	return {
		stations: JSON.parse(JSON.stringify(stations)),
		user: { _id: locals.user._id, username: locals.user.username },
		modelDeployed: deployedProjects.length > 0,
		deployedProjects: JSON.parse(JSON.stringify(deployedProjects)),
		recentInspections: JSON.parse(JSON.stringify(recentInspections))
	};
};

export const config = { maxDuration: 60 };
