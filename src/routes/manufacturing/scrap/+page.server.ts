import { fail, redirect } from '@sveltejs/kit';
import {
	connectDB, CartridgeRecord, ManualCartridgeRemoval, AuditLog, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
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
	 * Manually remove a group of wax-stored cartridges. Operators scan 1+
	 * cartridges, provide a reason, and submit. Each cartridge is marked
	 * scrapped and a scrap InventoryTransaction is written so the scrap audit
	 * (see scripts/audit-scrap-tracking.ts) remains clean.
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
			return fail(400, { removeWaxStored: { error: `Cannot remove: ${issues.join('; ')}` } });
		}

		const now = new Date();
		const removalId = generateId();
		const voidReason = `Manual wax-stored removal: ${reason}`;

		await ManualCartridgeRemoval.create({
			_id: removalId,
			cartridgeIds,
			reason,
			operator: { _id: locals.user._id, username: locals.user.username },
			removedAt: now
		});

		for (const cid of cartridgeIds) {
			await CartridgeRecord.findByIdAndUpdate(cid, {
				$set: { status: 'scrapped', voidedAt: now, voidReason }
			});

			await recordTransaction({
				transactionType: 'scrap',
				cartridgeRecordId: cid,
				quantity: 1,
				manufacturingStep: 'storage',
				manufacturingRunId: removalId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				scrapReason: reason,
				scrapCategory: 'other',
				notes: `Manual wax-stored removal (group ${removalId}): ${reason}`
			});

			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cid,
				action: 'UPDATE',
				changedBy: locals.user.username,
				changedAt: now,
				newData: { status: 'scrapped', voidedAt: now, voidReason, removalGroupId: removalId },
				reason: voidReason
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
