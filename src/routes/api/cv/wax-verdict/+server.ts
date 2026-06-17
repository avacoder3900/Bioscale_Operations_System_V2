/**
 * Wax-inspection verdict (WAX-INSPECTION-READY-REJECTED).
 * POST /api/cv/wax-verdict  { cartridgeId, verdict: 'ready'|'rejected', reason?, source? }
 *
 * Moves a photographed cart wax_qc → wax_ready | wax_rejected. The cartridgeId
 * comes from a physical QR scan in the UI (human path) — the scan IS the gate.
 * The cart MUST be in wax_qc (i.e. it has a photo and no verdict yet). Also
 * mirrors the decision into the legacy `waxQc` field so the DHR keeps rendering.
 * `source:'cv'` lets the future CV auto-verdict reuse this same transition.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({}) as any);
	const cartridgeId = body?.cartridgeId?.toString().trim();
	const verdict = body?.verdict?.toString().trim();
	const reason = body?.reason?.toString().trim() || '';
	const source = body?.source === 'cv' ? 'cv' : 'human';

	if (!cartridgeId) return json({ error: 'cartridgeId required' }, { status: 400 });
	if (verdict !== 'ready' && verdict !== 'rejected') {
		return json({ error: "verdict must be 'ready' or 'rejected'" }, { status: 400 });
	}
	if (verdict === 'rejected' && !reason) {
		return json({ error: 'A reason is required to reject a cartridge' }, { status: 400 });
	}

	await connectDB();
	const cart = (await CartridgeRecord.findById(cartridgeId).select('status').lean()) as any;
	if (!cart) return json({ error: `Cartridge ${cartridgeId} not found` }, { status: 404 });
	if (cart.status !== 'wax_qc') {
		const hint =
			cart.status === 'wax_stored'
				? 'photograph it first (it must be wax_qc)'
				: cart.status === 'wax_ready' || cart.status === 'wax_rejected'
					? `it already has a verdict (${cart.status})`
					: `it is in phase "${cart.status}"`;
		return json({ error: `Cartridge ${cartridgeId} can't be judged — ${hint}.` }, { status: 400 });
	}

	const newStatus = verdict === 'ready' ? 'wax_ready' : 'wax_rejected';
	const now = new Date();
	await CartridgeRecord.updateOne(
		{ _id: cartridgeId, status: 'wax_qc' },
		{
			$set: {
				status: newStatus,
				// Mirror into the legacy waxQc field so the DHR + stats keep working.
				'waxQc.status': verdict === 'ready' ? 'Accepted' : 'Rejected',
				'waxQc.rejectionReason': verdict === 'rejected' ? reason : undefined,
				'waxQc.source': source,
				'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
				'waxQc.timestamp': now,
				'waxQc.recordedAt': now
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_records',
		recordId: cartridgeId,
		action: 'wax_inspection_verdict',
		newData: { status: newStatus, verdict, source, reason: reason || undefined },
		changedAt: now,
		changedBy: locals.user.username
	});

	return json({ success: true, cartridgeId, status: newStatus });
};
