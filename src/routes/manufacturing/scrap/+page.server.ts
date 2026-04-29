import { fail, redirect } from '@sveltejs/kit';
import {
	connectDB, CartridgeRecord, ManualCartridgeRemoval, AuditLog, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Manual cartridge removal history — last 50 groups
	const removals = await ManualCartridgeRemoval.find({})
		.sort({ removedAt: -1 })
		.limit(50)
		.lean() as any[];

	const removalHistory = removals.map((r) => ({
		id: String(r._id),
		cartridgeIds: r.cartridgeIds ?? [],
		cartridgeCount: (r.cartridgeIds ?? []).length,
		reason: r.reason ?? '',
		operatorUsername: r.operator?.username ?? '',
		removedAt: r.removedAt ? new Date(r.removedAt).toISOString() : ''
	}));

	return { removalHistory };
};

export const actions: Actions = {
	/**
	 * Manually check out (remove) one or more wax-stored cartridges.
	 *
	 * IMPORTANT: checkout is orthogonal to scrap/quality status. A cartridge
	 * that was scrapped stays scrapped when checked out; a production-level
	 * cartridge stays at its production status. This action records the
	 * physical removal event only — it does NOT change CartridgeRecord.status
	 * and does NOT write an InventoryTransaction (cartridges are not
	 * inventoried as PartDefinitions; their raw materials were consumed at
	 * WI-01 backing when they came into existence).
	 *
	 * Wax-stored eligibility is enforced here because that's the intended
	 * point of checkout going forward; historical checkouts of completed
	 * cartridges are handled via a one-off backfill script, not this action.
	 */
	removeWaxStoredCartridges: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const cartridgeIdsRaw = (data.get('cartridgeIds') as string) ?? '';
		const reason = ((data.get('reason') as string) ?? '').trim();

		let cartridgeIds: string[] = [];
		try { cartridgeIds = JSON.parse(cartridgeIdsRaw); } catch { /* ignore */ }
		cartridgeIds = Array.from(new Set(cartridgeIds.map((s) => String(s).trim()).filter(Boolean)));

		if (cartridgeIds.length === 0) {
			return fail(400, { removeWaxStored: { error: 'Scan at least one cartridge barcode' } });
		}
		if (!reason) {
			return fail(400, { removeWaxStored: { error: 'Reason is required' } });
		}

		// Validate eligibility: each cartridge must exist and be status='wax_stored'.
		// Fail the whole group on any mismatch so operators get a clear failure
		// mode rather than a silent partial-success.
		const cartridges = await CartridgeRecord.find({ _id: { $in: cartridgeIds } })
			.select('_id status')
			.lean() as any[];
		const byId = new Map(cartridges.map((c) => [c._id, c]));
		const issues: string[] = [];
		for (const cid of cartridgeIds) {
			const c = byId.get(cid);
			if (!c) { issues.push(`${cid}: not found`); continue; }
			if (c.status !== 'wax_stored') { issues.push(`${cid}: status is '${c.status}', expected 'wax_stored'`); }
		}
		if (issues.length > 0) {
			return fail(400, { removeWaxStored: { error: `Cannot check out: ${issues.join('; ')}` } });
		}

		const now = new Date();
		const removalId = generateId();

		await ManualCartridgeRemoval.create({
			_id: removalId,
			cartridgeIds,
			reason,
			operator: { _id: locals.user._id, username: locals.user.username },
			removedAt: now
		});

		// AuditLog the checkout event per cartridge so the audit trail still
		// shows who checked this cartridge out and when, without mutating
		// its production status.
		for (const cid of cartridgeIds) {
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cid,
				action: 'CHECKOUT',
				changedBy: locals.user.username,
				changedAt: now,
				newData: { checkedOut: true, removalGroupId: removalId, reason },
				reason: `Manual checkout: ${reason}`
			});
		}

		return {
			removeWaxStored: {
				success: true,
				removalId,
				count: cartridgeIds.length
			}
		};
	}
};
