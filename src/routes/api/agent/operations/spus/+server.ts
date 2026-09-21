import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Spu } from '$lib/server/db';
import type { RequestHandler } from './$types';

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
			wells: Array.isArray(mag?.results)
				? mag.results.map((w: any) => ({
						well: w.well,
						chA_Z: w.chA_Z ?? null,
						chA_pass: inRange(w.chA_Z),
						chB_Z: w.chB_Z ?? null,
						chB_pass: inRange(w.chB_Z),
						chC_Z: w.chC_Z ?? null,
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
					'"Well | Ch A (Z) | Ch B (Z) | Ch C (Z)" — ONE Z value per cell with a check/cross from chX_pass, ' +
					'headed by "Criteria: Z range <minZ> - <maxZ>". Never show raw T/X/Y axis values unless the user asks ' +
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
