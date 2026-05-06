import { fail, redirect } from '@sveltejs/kit';
import {
	connectDB, CartridgeRecord, ManualCartridgeRemoval, BackingLot, AuditLog, generateId
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
		// Pre-wax removals store an explicit count and no cartridgeIds; fall
		// back to ids.length for legacy wax-stored entries.
		cartridgeCount: typeof r.cartridgeCount === 'number'
			? r.cartridgeCount
			: (r.cartridgeIds ?? []).length,
		backingLotId: r.backingLotId ?? null,
		reason: r.reason ?? '',
		operatorUsername: r.operator?.username ?? '',
		removedAt: r.removedAt ? new Date(r.removedAt).toISOString() : ''
	}));

	return { removalHistory };
};

export const actions: Actions = {
	/**
	 * Manually check out (remove) one or more cartridges from any post-wax
	 * status. Checkout is orthogonal to quality status: a scrapped cartridge
	 * stays scrapped, a completed cartridge stays completed. This action
	 * records the physical removal event only — it does NOT change
	 * CartridgeRecord.status. Every count query that observes a cartridge's
	 * current state is responsible for excluding checked-out IDs via
	 * getCheckedOutCartridgeIds() so the cartridge drops out of fridge,
	 * oven, phase, and QC counts simultaneously.
	 *
	 * Form action name is preserved (removeWaxStoredCartridges) for UI
	 * compatibility, but eligibility is now status-agnostic — any existing
	 * cartridge can be checked out.
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

		// Validate existence only — status is preserved on checkout, so any
		// status is eligible (wax_stored, scrapped, completed, etc.). Fail
		// the whole group on any "not found" so operators see a clear
		// failure mode rather than a silent partial-success.
		const cartridges = await CartridgeRecord.find({ _id: { $in: cartridgeIds } })
			.select('_id status')
			.lean() as any[];
		const byId = new Map(cartridges.map((c) => [c._id, c]));
		const issues: string[] = [];
		for (const cid of cartridgeIds) {
			if (!byId.has(cid)) issues.push(`${cid}: not found`);
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
		// its production status. Capture status at checkout time so the
		// removal record is self-describing in the audit history.
		for (const cid of cartridgeIds) {
			const statusAtCheckout = byId.get(cid)?.status ?? null;
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cid,
				action: 'CHECKOUT',
				changedBy: locals.user.username,
				changedAt: now,
				newData: { checkedOut: true, removalGroupId: removalId, reason, statusAtCheckout },
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
	},

	/**
	 * Manually remove (pre-wax) cartridges from a BackingLot bucket sitting in
	 * an oven. CartridgeRecords don't exist yet at this stage — cartridges are
	 * an aggregate count on BackingLot.cartridgeCount until their UUID is
	 * scanned at wax deck loading. So this action mirrors the wax-filling
	 * loadDeck pattern (atomic conditional decrement; mark consumed on drain)
	 * without creating any CartridgeRecord rows.
	 */
	removeFromBackingLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const lotBarcode = ((data.get('lotBarcode') as string) ?? '').trim();
		const countRaw = (data.get('count') as string) ?? '1';
		const reason = ((data.get('reason') as string) ?? '').trim();

		if (!lotBarcode) {
			return fail(400, { removeBackingLot: { error: 'Scan the backing lot barcode' } });
		}
		const count = Number(countRaw);
		if (!Number.isInteger(count) || count <= 0) {
			return fail(400, { removeBackingLot: { error: 'Count must be a positive whole number' } });
		}
		if (!reason) {
			return fail(400, { removeBackingLot: { error: 'Reason is required' } });
		}

		// Atomic conditional decrement — refuses to over-pull. Same pattern as
		// wax-filling loadDeck so concurrent wax loads + manual checkouts can't
		// drive cartridgeCount negative. See wax-filling/+page.server.ts:629.
		const updatedLot = await BackingLot.findOneAndUpdate(
			{ _id: lotBarcode, cartridgeCount: { $gte: count } },
			{ $inc: { cartridgeCount: -count } },
			{ new: true }
		).lean() as any;

		if (!updatedLot) {
			const current = await BackingLot.findById(lotBarcode)
				.select('cartridgeCount status').lean() as any;
			if (!current) {
				return fail(404, { removeBackingLot: { error: `Backing lot "${lotBarcode}" not found` } });
			}
			return fail(400, {
				removeBackingLot: {
					error: `Backing lot ${lotBarcode} has only ${current.cartridgeCount ?? 0} cartridge(s) remaining (status=${current.status ?? 'unknown'}); cannot remove ${count}.`
				}
			});
		}

		const now = new Date();
		const remainingAfter = updatedLot.cartridgeCount ?? 0;

		// Mirror loadDeck: when the bucket drains, mark the lot consumed so it
		// drops out of the wax-filling "buckets in ovens" picker.
		if (remainingAfter <= 0) {
			await BackingLot.findByIdAndUpdate(lotBarcode, {
				$set: { cartridgeCount: 0, status: 'consumed' }
			});
		}

		const removalId = generateId();
		await ManualCartridgeRemoval.create({
			_id: removalId,
			cartridgeIds: [],
			cartridgeCount: count,
			backingLotId: lotBarcode,
			reason,
			operator: { _id: locals.user._id, username: locals.user.username },
			removedAt: now
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'backing_lots',
			recordId: lotBarcode,
			action: 'CHECKOUT',
			changedBy: locals.user.username,
			changedAt: now,
			oldData: { cartridgeCount: remainingAfter + count },
			newData: { cartridgeCount: remainingAfter, removalGroupId: removalId, count, reason },
			reason: `Manual pre-wax removal: ${reason}`
		});

		return {
			removeBackingLot: {
				success: true,
				removalId,
				lotBarcode,
				count,
				remaining: remainingAfter,
				consumed: remainingAfter <= 0
			}
		};
	}
};
