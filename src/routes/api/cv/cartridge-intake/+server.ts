/**
 * POST /api/cv/cartridge-intake
 *
 * Capture-page intake: after a barcode scan, assign the cartridge to an
 * inspect step. Creates the CartridgeRecord if the barcode isn't in BIMS
 * (the scanned code IS the _id), or re-statuses an existing one, so the
 * step's scan-gated flow accepts it:
 *
 *   wax         → status 'wax_stored'  (photo advances it to wax_qc → verdict)
 *   reagent     → status 'sealed'      (photo advances it to reagent_qc → verdict)
 *   post_mortem → status 'completed'   (post-mortem photos don't re-status)
 *
 * Body: { cartridgeId: string, inspectStep: 'wax' | 'reagent' | 'post_mortem' }
 * Returns: { cartridgeId, status, created, phase } — phase is the capture
 * phase the step's inspect page expects.
 */
import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection.js';
import { CartridgeRecord } from '$lib/server/db/models/cartridge-record.js';
import { AuditLog } from '$lib/server/db/models/index.js';
import { generateId } from '$lib/server/db/utils.js';
import { hasPermission } from '$lib/server/permissions';
import type { RequestHandler } from './$types';

const STEPS: Record<string, { status: string; phase: string }> = {
	wax: { status: 'wax_stored', phase: 'wax_filled' },
	reagent: { status: 'sealed', phase: 'reagent_filled' },
	post_mortem: { status: 'completed', phase: 'post_mortem' }
};

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) throw error(401, 'Unauthorized');
	if (!hasPermission(locals.user, 'cv:write') && !hasPermission(locals.user, 'manufacturing:write')) {
		throw error(403, 'Forbidden');
	}

	await connectDB();

	const body = await request.json().catch(() => ({}));
	const cartridgeId = body.cartridgeId?.toString().trim();
	const inspectStep = body.inspectStep?.toString();
	if (!cartridgeId) return json({ error: 'cartridgeId is required' }, { status: 400 });
	const step = STEPS[inspectStep];
	if (!step) {
		return json({ error: `inspectStep must be one of: ${Object.keys(STEPS).join(', ')}` }, { status: 400 });
	}

	const existing = (await CartridgeRecord.findById(cartridgeId).select('status').lean()) as any;
	const now = new Date();

	if (existing) {
		await CartridgeRecord.updateOne({ _id: cartridgeId }, { $set: { status: step.status } });
	} else {
		await CartridgeRecord.create({
			_id: cartridgeId,
			status: step.status,
			photos: [],
			photoSequence: 0,
			notes: [],
			corrections: []
		});
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_records',
		recordId: cartridgeId,
		action: 'cartridge_intake',
		oldData: existing ? { status: existing.status ?? null } : null,
		newData: { status: step.status, inspectStep, created: !existing },
		changedAt: now,
		changedBy: locals.user.username
	});

	return json({
		cartridgeId,
		status: step.status,
		phase: step.phase,
		created: !existing
	});
};
