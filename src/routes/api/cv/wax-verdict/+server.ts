/**
 * Wax-stage verdict (WAX-SIMPLIFY-2).
 * POST /api/cv/wax-verdict  { cartridgeId, verdict: 'ready'|'rejected', reason?, imageId?, source? }
 *
 * The Wax Reject page sends verdict:'rejected' after the operator has scanned a
 * cart's QR and snapped its photo — the scan IS the gate, the photo is the
 * training record. Passing visual inspection is implicit (no status change), so
 * the UI never sends 'ready'; the API still accepts it for the day a CV model /
 * human verdict path returns (source:'cv' reserved for that).
 *
 * Eligible-from statuses: wax_filled | wax_ready (live) plus legacy wax_qc /
 * wax_stored so an unmigrated cart can still be rejected. Mirrors the decision
 * into the legacy `waxQc` field so the DHR keeps rendering.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import { WAX_REJECTABLE_STATUSES } from '$lib/shared/cartridge-wax-status';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const body = await request.json().catch(() => ({}) as any);
	const cartridgeId = body?.cartridgeId?.toString().trim();
	const verdict = body?.verdict?.toString().trim();
	const reason = body?.reason?.toString().trim() || '';
	const imageId = body?.imageId?.toString().trim() || undefined;
	const source = body?.source === 'cv' ? 'cv' : 'human';

	if (!cartridgeId) return json({ error: 'cartridgeId required' }, { status: 400 });
	if (verdict !== 'ready' && verdict !== 'rejected') {
		return json({ error: "verdict must be 'ready' or 'rejected'" }, { status: 400 });
	}

	await connectDB();
	const cart = (await CartridgeRecord.findById(cartridgeId).select('status').lean()) as any;
	if (!cart) return json({ error: `Cartridge ${cartridgeId} not found` }, { status: 404 });
	if (!(WAX_REJECTABLE_STATUSES as readonly string[]).includes(cart.status)) {
		const hint =
			cart.status === 'wax_rejected'
				? 'it is already wax_rejected'
				: `it is in phase "${cart.status}"`;
		return json({ error: `Cartridge ${cartridgeId} can't be judged — ${hint}.` }, { status: 400 });
	}

	const from = cart.status;
	const newStatus = verdict === 'ready' ? 'wax_ready' : 'wax_rejected';
	const now = new Date();
	const set: Record<string, unknown> = {
		status: newStatus,
		priorStatus: from,
		// Mirror into the legacy waxQc field so the DHR + stats keep working.
		'waxQc.status': verdict === 'ready' ? 'Accepted' : 'Rejected',
		'waxQc.source': source,
		'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
		'waxQc.timestamp': now,
		'waxQc.recordedAt': now
	};
	if (verdict === 'rejected' && reason) set['waxQc.rejectionReason'] = reason;
	const res = await CartridgeRecord.updateOne({ _id: cartridgeId, status: from }, { $set: set });
	if (res.matchedCount === 0) {
		return json({ error: `Cartridge ${cartridgeId} changed status mid-request — rescan it.` }, { status: 409 });
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_records',
		recordId: cartridgeId,
		action: 'wax_inspection_verdict',
		newData: { status: newStatus, from, verdict, source, reason: reason || undefined, imageId },
		changedAt: now,
		changedBy: locals.user.username
	});

	return json({ success: true, cartridgeId, status: newStatus, from });
};
