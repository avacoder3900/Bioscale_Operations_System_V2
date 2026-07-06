/**
 * /manufacturing/cart-mfg/post-mortem-inspect — inline CV deployment point
 * (POST-MORTEM-INSPECT, no-state-change variant).
 *
 * Runs AFTER a cartridge has been ran (status `completed`): a ran cartridge is
 * photographed here and the deployed model's verdict is shown immediately. Unlike
 * the wax/reagent inspect flows, photographing a cart here does NOT change its
 * status — it stays `completed`. The photo simply lands in the cartridge's photos[]
 * (phase 'post_mortem') and any deployed model's PASS/FAIL is advisory only.
 *
 * Capture/station plumbing mirrors /reagent-inspect (the proven implementation).
 *
 * Server load supplies:
 *   - stations:          all CaptureStations (status-badged; tokens fetched on demand)
 *   - modelDeployed:     does ANY CvProject deploy at 'post_mortem' with an active model?
 *   - deployedProjects:  name/version of those projects for the header display
 *   - recentInspections: last 50 post_mortem CvInspections joined with CvImage thumbnails
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CaptureStation, deriveStatus } from '$lib/server/db/models/capture-station.js';
import { CvProject } from '$lib/server/db/models/cv-project.js';
import { CvInspection } from '$lib/server/db/models/cv-inspection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { getR2Url } from '$lib/server/services/r2';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

const PHASE = 'post_mortem';

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

	// Is anything actually deployed at post_mortem? Drives the yellow
	// "captures will save without inference" notice when nothing is.
	const deployedRaw = await CvProject.find({
		phases: PHASE,
		activeModelVersion: { $ne: null }
	})
		.select('_id name activeModelVersion')
		.lean() as any[];
	const deployedProjects = deployedRaw.map((p: any) => ({
		id: p._id,
		name: p.name ?? '(unnamed project)',
		version: p.activeModelVersion
	}));

	// Last 50 post_mortem inspections (newest first), joined with their CvImage
	// for thumbnail + operator. Shadow inspections are included but flagged so
	// the UI can caption them instead of presenting them as operator verdicts.
	const inspectionsRaw = await CvInspection.find({ phase: PHASE })
		.sort({ createdAt: -1 })
		.limit(50)
		.lean() as any[];

	const imageIds = Array.from(
		new Set(inspectionsRaw.map((i: any) => i.imageId).filter(Boolean))
	);
	// Photo thumbnails + operator come from cartridge_records.photos[] (truth).
	const photoRows = imageIds.length > 0
		? await CartridgeRecord.aggregate([
			{ $match: { 'photos.imageId': { $in: imageIds } } },
			{ $unwind: '$photos' },
			{ $match: { 'photos.imageId': { $in: imageIds } } },
			{ $project: { _id: 0, imageId: '$photos.imageId', r2Url: '$photos.r2Url', r2Key: '$photos.r2Key', operator: '$photos.capturedBy.username' } }
		]) as any[]
		: [];
	const imageById = new Map<string, any>(photoRows.map((p: any) => [p.imageId, p]));

	const recentInspections = inspectionsRaw.map((i: any) => {
		const img = i.imageId ? imageById.get(i.imageId) : undefined;
		return {
			id: i._id,
			imageId: i.imageId ?? null,
			cartridgeRecordId: i.cartridgeRecordId ?? null,
			imageUrl: img?.r2Url ?? (img?.r2Key ? getR2Url(img.r2Key) : null),
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
