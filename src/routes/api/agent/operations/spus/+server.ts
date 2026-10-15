import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Spu } from '$lib/server/db';
import type { RequestHandler } from './$types';

// ------------------------------------------------------------ field magnitude
// |B| = sqrt(X^2 + Y^2 + Z^2) per channel, in gauss — the same unit the stored
// X/Y/Z already carry, so no conversion is applied. Ingest persists chX_mag per
// well plus a session-level fieldSummary; the derive-on-read fallback keeps
// sessions recorded before that from reading back magnitude-less. Never NaN.
const FIELD_UNIT = 'gauss';

function magAxis(well: any, key: string): number | null {
	const v = well?.[key];
	return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Stored magnitude when present, else derived from stored X/Y/Z, else null. */
function channelMag(well: any, ch: 'A' | 'B' | 'C'): number | null {
	const stored = magAxis(well, `ch${ch}_mag`);
	if (stored !== null) return stored;
	const x = magAxis(well, `ch${ch}_X`);
	const y = magAxis(well, `ch${ch}_Y`);
	const z = magAxis(well, `ch${ch}_Z`);
	if (x === null || y === null || z === null) return null;
	const m = Math.sqrt(x * x + y * y + z * z);
	return Number.isFinite(m) ? m : null;
}

function fieldSummaryFor(wells: unknown) {
	const list = Array.isArray(wells) ? wells : [];
	const mags: number[] = [];
	for (const well of list) {
		for (const ch of ['A', 'B', 'C'] as const) {
			const m = channelMag(well, ch);
			if (m !== null) mags.push(m);
		}
	}
	return {
		unit: FIELD_UNIT,
		wellCount: list.length,
		minMag: mags.length ? Math.min(...mags) : null,
		maxMag: mags.length ? Math.max(...mags) : null,
		meanMag: mags.length ? mags.reduce((a, b) => a + b, 0) / mags.length : null
	};
}

/**
 * Read-only SPU status surface for the BIMS MCP server.
 *
 * Single lookup:  GET /api/agent/operations/spus?spuId=<id>
 *                 GET /api/agent/operations/spus?udi=<udi>
 *                 GET /api/agent/operations/spus?barcode=<barcode>
 *
 * List/filter:    GET /api/agent/operations/spus?status=validating&batch=<batchNumber>&limit=25
 *
 * Auth: x-api-key | x-agent-api-key | Authorization: Bearer <AGENT_API_KEY>
 */

const VALIDATION_MODALITIES = ['magnetometer', 'thermocouple', 'lux', 'spectrophotometer'] as const;

function mapSpu(s: any) {
	const v = s.validation ?? {};
	return {
		id: s._id,
		udi: s.udi,
		barcode: s.barcode ?? null,
		status: s.status ?? null,
		assemblyStatus: s.assemblyStatus ?? null,
		qcStatus: s.qcStatus ?? null,
		deviceState: s.deviceState ?? null,
		batch: s.batch?._id ? { id: s.batch._id, batchNumber: s.batch.batchNumber ?? null } : null,
		customer: s.assignment?.customer?.name ?? null,
		particleDeviceId: s.particleLink?.particleDeviceId ?? null,
		validation: {
			overall: v.status ?? 'pending',
			...Object.fromEntries(
				VALIDATION_MODALITIES.map((m) => [
					m,
					{
						status: v[m]?.status ?? 'pending',
						completedAt: v[m]?.completedAt ?? null,
						failureReasons: v[m]?.failureReasons ?? []
					}
				])
			)
		},
		finalizedAt: s.finalizedAt ?? null,
		voidedAt: s.voidedAt ?? null,
		createdAt: s.createdAt ?? null,
		updatedAt: s.updatedAt ?? null
	};
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const spuId = url.searchParams.get('spuId');
	const udi = url.searchParams.get('udi');
	const barcode = url.searchParams.get('barcode');

	// Single-SPU lookup by any unique identifier
	if (spuId || udi || barcode) {
		const lookup = spuId ? { _id: spuId } : udi ? { udi } : { barcode };
		const spu = (await Spu.findOne(lookup as any).lean()) as any;
		if (!spu) {
			return json({ success: false, error: 'SPU not found' }, { status: 404 });
		}
		const mapped = mapSpu(spu);

		// BIMS-style magnetometer detail: the page shows ONE value per cell — the
		// Z per channel with a pass mark against the criteria — never the raw
		// T/X/Y axis values.
		const mag = spu.validation?.magnetometer;
		const criteria =
			mag?.criteriaUsed && typeof mag.criteriaUsed === 'object' ? mag.criteriaUsed : null;
		const inRange = (z: unknown): boolean | null =>
			typeof z === 'number' &&
			typeof criteria?.minZ === 'number' &&
			typeof criteria?.maxZ === 'number'
				? z >= criteria.minZ && z <= criteria.maxZ
				: null;
		(mapped.validation as any).magnetometer = {
			...(mapped.validation as any).magnetometer,
			testRanAt: mag?.testRanAt ?? null,
			criteria,
			fieldSummary:
				mag?.fieldSummary ?? (Array.isArray(mag?.results) ? fieldSummaryFor(mag.results) : null),
			wells: Array.isArray(mag?.results)
				? mag.results.map((w: any) => ({
						well: w.well,
						chA_X: magAxis(w, 'chA_X'),
						chA_Y: magAxis(w, 'chA_Y'),
						chA_Z: w.chA_Z ?? null,
						chA_mag: channelMag(w, 'A'),
						chA_pass: inRange(w.chA_Z),
						chB_X: magAxis(w, 'chB_X'),
						chB_Y: magAxis(w, 'chB_Y'),
						chB_Z: w.chB_Z ?? null,
						chB_mag: channelMag(w, 'B'),
						chB_pass: inRange(w.chB_Z),
						chC_X: magAxis(w, 'chC_X'),
						chC_Y: magAxis(w, 'chC_Y'),
						chC_Z: w.chC_Z ?? null,
						chC_mag: channelMag(w, 'C'),
						chC_pass: inRange(w.chC_Z)
					}))
				: []
		};
		const spectro = spu.validation?.spectrophotometer;
		if (spectro?.results) (mapped.validation as any).spectrophotometer.results = spectro.results;

		return json({
			success: true,
			data: {
				spu: mapped,
				guidance:
					'PRESENTATION — magnetometer: render validation.magnetometer.wells as the BIMS table ' +
					'"Well | Ch A (X, Y, Z, |B|) | Ch B (...) | Ch C (...)" with a check/cross per channel from chX_pass, ' +
					'headed by "Criteria: Z range <minZ> - <maxZ>" — pass/fail is judged on Z alone. chX_mag is the field ' +
					'magnitude |B| = sqrt(X^2 + Y^2 + Z^2); every value is in gauss, and fieldSummary carries min/max/mean ' +
					'|B| for the run. Never show the raw T (temperature) column unless the user asks ' +
					'for raw device output. HISTORIES: this record holds only the latest rollup per modality — for full ' +
					'run histories use the find_test_results / validation_tab tools if available, otherwise run_saved_query ' +
					'with "SPU Validation Sessions" (magnetometer/thermocouple) or "Validation Runs". OPTICS: optical runs ' +
					'live on cartridge_records with device.name = this SPU\'s UDI (rolled up here under spectrophotometer); ' +
					'they are NOT in validation_sessions.'
			}
		});
	}

	// List with optional filters
	const filter: Record<string, unknown> = {};
	const status = url.searchParams.get('status');
	const batch = url.searchParams.get('batch');
	const customer = url.searchParams.get('customer');
	if (status) filter.status = status;
	if (batch) {
		// Accept either a batch _id or a human batchNumber
		filter.$or = [{ 'batch._id': batch }, { 'batch.batchNumber': batch }];
	}
	if (customer) filter['assignment.customer.name'] = customer;

	const limit = Math.min(Number(url.searchParams.get('limit')) || 25, 100);

	const spus = await Spu.find(filter as any)
		.sort({ updatedAt: -1 })
		.limit(limit)
		.lean();

	const mapped = (spus as any[]).map(mapSpu);

	// Status breakdown for the returned set
	const byStatus: Record<string, number> = {};
	for (const s of mapped) {
		const k = s.status ?? 'unknown';
		byStatus[k] = (byStatus[k] ?? 0) + 1;
	}

	return json({
		success: true,
		data: {
			spus: mapped,
			summary: { count: mapped.length, limit, byStatus }
		}
	});
};
