/**
 * /cv/stations — admin list of registered Pi capture stations.
 *
 * Read-only at this stage. Story D2 layers in rename / force-release /
 * rotate-secret / delete on the detail page; this list just gives the
 * admin a place to see the whole fleet at once with derived status.
 *
 * Per docs/prds/PI-STATION-ADMIN-AND-LIFECYCLE.md story D1.
 */
import { error, redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import {
	CaptureStation,
	deriveStatus
} from '$lib/server/db/models/capture-station.js';
import { hasPermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	if (
		!hasPermission(locals.user, 'cv:write') &&
		!hasPermission(locals.user, 'manufacturing:write')
	) {
		throw error(403, 'Forbidden');
	}

	await connectDB();

	const raw = (await CaptureStation.find()
		.select(
			'_id name hostname ipAddress location agentVersion status lastSeenAt ' +
				'agentReportedAt capabilities mode assignedPhase currentOperator health createdAt'
		)
		.sort({ name: 1 })
		.lean()) as Array<Record<string, any>>;

	const stations = raw.map((s) => ({
		id: s._id,
		name: s.name ?? '',
		hostname: s.hostname ?? '',
		ipAddress: s.ipAddress ?? null,
		location: s.location ?? null,
		agentVersion: s.agentVersion ?? null,
		// Always send the derived status — between sweeps, the stored value
		// can lag behind the heartbeat clock.
		status: deriveStatus(s),
		storedStatus: s.status ?? null,
		lastSeenAt: s.lastSeenAt ? new Date(s.lastSeenAt).toISOString() : null,
		agentReportedAt: s.agentReportedAt
			? new Date(s.agentReportedAt).toISOString()
			: null,
		capabilities: s.capabilities ?? {
			camera: false,
			scanner: false,
			led: false,
			robotArm: false
		},
		mode: s.mode ?? 'free',
		assignedPhase: s.assignedPhase ?? null,
		currentOperator: s.currentOperator
			? {
					username: s.currentOperator.username ?? '',
					since: s.currentOperator.since
						? new Date(s.currentOperator.since).toISOString()
						: null
				}
			: null,
		health: s.health
			? {
					cameraOk: !!s.health.cameraOk,
					scannerOk: !!s.health.scannerOk,
					ledOk: !!s.health.ledOk,
					uptimeS: s.health.uptimeS ?? 0
				}
			: null,
		createdAt: s.createdAt ? new Date(s.createdAt).toISOString() : null
	}));

	return { stations };
};

export const config = { maxDuration: 60 };
