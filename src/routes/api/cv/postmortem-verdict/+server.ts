/**
 * Post-mortem inspection verdict (POST-MORTEM-INSPECT).
 * POST /api/cv/postmortem-verdict  { cartridgeId, verdict: 'ready'|'rejected', reason?, source? }
 *
 * Moves a photographed ran cart postmortem_qc → postmortem_ready | postmortem_rejected.
 * The cartridgeId comes from a physical QR scan in the UI (human path) — the scan IS
 * the gate. The cart MUST be in postmortem_qc (it has a post-mortem photo and no
 * verdict yet). Mirrors the decision into the `postMortemInspection` field for the DHR.
 * `source:'cv'` lets a future CV auto-verdict reuse this same transition.
 * Mirror of /api/cv/reagent-verdict, pinned to the post-mortem flow.
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
	if (cart.status !== 'postmortem_qc') {
		const hint =
			cart.status === 'completed'
				? 'photograph it first (it must be postmortem_qc)'
				: cart.status === 'postmortem_ready' || cart.status === 'postmortem_rejected'
					? `it already has a verdict (${cart.status})`
					: `it is in phase "${cart.status}"`;
		return json({ error: `Cartridge ${cartridgeId} can't be judged — ${hint}.` }, { status: 400 });
	}

	const newStatus = verdict === 'ready' ? 'postmortem_ready' : 'postmortem_rejected';
	const now = new Date();
	await CartridgeRecord.updateOne(
		{ _id: cartridgeId, status: 'postmortem_qc' },
		{
			$set: {
				status: newStatus,
				// Mirror into the postMortemInspection field so the DHR + stats can render it.
				'postMortemInspection.status': verdict === 'ready' ? 'Accepted' : 'Rejected',
				'postMortemInspection.reason': verdict === 'rejected' ? reason : undefined,
				'postMortemInspection.source': source,
				'postMortemInspection.operator': { _id: locals.user._id, username: locals.user.username },
				'postMortemInspection.timestamp': now,
				'postMortemInspection.recordedAt': now
			}
		}
	);

	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_records',
		recordId: cartridgeId,
		action: 'post_mortem_inspection_verdict',
		newData: { status: newStatus, verdict, source, reason: reason || undefined },
		changedAt: now,
		changedBy: locals.user.username
	});

	return json({ success: true, cartridgeId, status: newStatus });
};
