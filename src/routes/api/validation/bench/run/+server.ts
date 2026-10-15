import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, Spu } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	FIRMWARE_POSITION_LIMIT_UM,
	parseBenchType,
	recordBenchFailure,
	runBenchRead,
	validateScan
} from '$lib/server/optical-bench';

// One unit of an optical-bench fleet run ("Run on all units" on
// /validation/bench). The page calls this once per unit, a few in parallel,
// because a single read can block ~36 s — a server-side loop over the fleet
// would blow the 60 s function limit. Every call carries the run's batchId so
// the batch view and CSV can gather all units back together.
//
// Body: { spuId, batchId, type?, start?, end?, stepUm?, skipReason? }
//   skipReason — the page already knows the unit is offline (one fleet status
//   call); record it in the batch without spending a 15 s Particle timeout.
const BATCH_ID = /^[A-Za-z0-9_-]{4,64}$/;

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'spu:write');
	await connectDB();

	const body = await request.json().catch(() => ({}));
	const batchId = String(body.batchId ?? '');
	if (!BATCH_ID.test(batchId)) return json({ ok: false, error: 'Missing or malformed batchId' }, { status: 400 });
	const num = (v: unknown, d: number) => (v === undefined || v === null || v === '' ? d : Number.isFinite(Number(v)) ? Number(v) : d);
	const req = {
		spuId: String(body.spuId ?? ''),
		type: parseBenchType(body.type),
		start: num(body.start, FIRMWARE_POSITION_LIMIT_UM - 4400),
		end: num(body.end, FIRMWARE_POSITION_LIMIT_UM),
		stepUm: num(body.stepUm, 400),
		batchId
	};
	const who = { _id: locals.user._id, username: locals.user.username };
	if (!req.spuId) return json({ ok: false, error: 'Pick a unit' }, { status: 400 });

	// Reject bad scan args before touching any unit (and before recording a failure).
	const scanErr = validateScan(req.type, req.start, req.end, req.stepUm);
	if (scanErr) return json({ ok: false, error: scanErr }, { status: 400 });

	if (body.skipReason) {
		const spu = (await Spu.findById(req.spuId).select('udi particleLink.particleDeviceId').lean()) as any;
		if (!spu) return json({ ok: false, error: 'Unknown unit' }, { status: 404 });
		const error = `Skipped — ${String(body.skipReason).slice(0, 120)}`;
		await recordBenchFailure(req, spu, error, who);
		return json({ ok: false, skipped: true, error, spuUdi: spu.udi });
	}

	const out = await runBenchRead(req, who);
	// A unit-level failure is a normal batch outcome, not an HTTP error — the page
	// keeps going and shows it in the row.
	if (!out.ok) return json({ ok: false, error: out.error, spuUdi: out.spuUdi ?? null });
	return json({ ok: true, type: out.type, sessionId: out.sessionId, spuUdi: out.spuUdi, result: out.result });
};

export const config = { maxDuration: 60 };
