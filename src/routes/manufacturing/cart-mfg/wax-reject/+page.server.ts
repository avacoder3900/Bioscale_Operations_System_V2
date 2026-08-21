/**
 * /manufacturing/cart-mfg/wax-reject — reject-only visual wax inspection
 * (WAX-SIMPLIFY-2).
 *
 * Carts are inspected by eye at the bench at wax_filled. Passing is implicit
 * (no status change). Rejects go in a bucket and come here: scan → snap a photo
 * (mandatory — the photo is the failure training record) → Reject → status
 * wax_rejected. Sibling of /wax-inspect (same scanner sticky context, Pi
 * station + USB capture paths, POST /api/cv/capture at phase 'wax_filled') with
 * the PASS/FAIL verdict UI stripped; the only action is Reject via
 * POST /api/cv/wax-verdict.
 *
 * Server load supplies:
 *   - stations:       all CaptureStations (status-badged; tokens fetched on demand)
 *   - counts:         wax_filled (bench queue) + wax_rejected today
 *   - recentRejects:  last 50 wax_rejected carts w/ latest wax_filled photo
 */
import { redirect } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { CaptureStation, deriveStatus } from '$lib/server/db/models/capture-station.js';
import { getR2Url } from '$lib/server/services/r2';
import { requirePermission } from '$lib/server/permissions';
import { WAX_REJECTABLE_STATUSES } from '$lib/shared/cartridge-wax-status';
import type { PageServerLoad } from './$types';

const PHASE = 'wax_filled';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Pi capture stations for the station dropdown — mirror of /wax-inspect.
	// Tokens are never sent — fetched on demand via /api/cv/stations/[id]/token.
	const stationsRaw = await CaptureStation.find()
		.select('_id name hostname capabilities mode assignedPhase status lastSeenAt currentOperator')
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

	const startOfToday = new Date();
	startOfToday.setHours(0, 0, 0, 0);
	const [waxFilled, rejectedToday, recentRaw] = await Promise.all([
		CartridgeRecord.countDocuments({ status: 'wax_filled' }),
		CartridgeRecord.countDocuments({ status: 'wax_rejected', 'waxQc.timestamp': { $gte: startOfToday } }),
		CartridgeRecord.find({ status: 'wax_rejected' })
			.select('_id waxQc photos')
			.sort({ 'waxQc.timestamp': -1 })
			.limit(50)
			.lean() as Promise<any[]>
	]);

	const recentRejects = recentRaw.map((c: any) => {
		const photos: any[] = Array.isArray(c.photos) ? c.photos : [];
		const wax = photos.filter((p) => p.phase === PHASE);
		const latest = (wax.length ? wax : photos)
			.slice()
			.sort((a, b) => new Date(b.capturedAt ?? 0).getTime() - new Date(a.capturedAt ?? 0).getTime())[0];
		return {
			cartridgeId: String(c._id),
			imageId: latest?.imageId ?? null,
			imageUrl: latest?.r2Url ?? (latest?.r2Key ? getR2Url(latest.r2Key) : null),
			reason: c.waxQc?.rejectionReason ?? null,
			operator: c.waxQc?.operator?.username ?? null,
			at: c.waxQc?.timestamp ?? null
		};
	});

	return {
		stations: JSON.parse(JSON.stringify(stations)),
		user: { _id: locals.user._id, username: locals.user.username },
		counts: { wax_filled: waxFilled, wax_rejected_today: rejectedToday },
		allowedStatuses: [...WAX_REJECTABLE_STATUSES],
		recentRejects: JSON.parse(JSON.stringify(recentRejects))
	};
};

export const config = { maxDuration: 60 };
