/**
 * Cartridge State Change — bulk-scan cartridge barcodes and move them all to one
 * target status.
 *
 * Replaces the old Quick Reagent Fill Test shortcut, which was this same
 * bulk-scan tool hard-wired to a single destination (status → wax_ready +
 * reagent fill cleared). That case is still reachable here: pick `wax_ready` as
 * the target and tick "Clear reagent fill".
 *
 * Rules:
 *  - Target status must be one of the cartridge_records schema statuses (the list
 *    is read off the Mongoose schema at runtime, so it can never drift).
 *  - A barcode with no cartridge is REJECTED by default. "Create unknown
 *    barcodes" opts in to originating them directly at the target status.
 *  - Every changed cartridge gets `priorStatus`, a phase-scoped note, and an
 *    AuditLog row.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

/** The status enum, read straight off the schema — single source of truth. */
function statusList(): string[] {
	const path = CartridgeRecord.schema.path('status') as unknown as { enumValues?: string[] };
	return path?.enumValues ?? [];
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [total, byStatus] = await Promise.all([
		CartridgeRecord.estimatedDocumentCount(),
		CartridgeRecord.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
	]);

	const counts: Record<string, number> = {};
	for (const row of byStatus as { _id: string | null; n: number }[]) {
		if (row._id) counts[row._id] = row.n;
	}

	return { statuses: statusList(), total, counts };
};

export const actions: Actions = {
	changeState: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const raw = (data.get('barcodes') as string) ?? '';
		const target = ((data.get('targetStatus') as string) ?? '').trim();
		const createUnknown = data.get('createUnknown') === 'on';
		const clearReagentFill = data.get('clearReagentFill') === 'on';
		const reason = ((data.get('reason') as string) ?? '').trim();

		if (!statusList().includes(target)) {
			return fail(400, { error: `Pick a target status (got "${target || 'none'}")` });
		}

		// Split on any whitespace/newlines (scanner sends barcode + Enter), trim, dedup.
		const barcodes = Array.from(
			new Set(raw.split(/\s+/).map((s) => s.trim()).filter(Boolean))
		);
		if (barcodes.length === 0) return fail(400, { error: 'Scan at least one cartridge barcode' });

		const op = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();
		const changed: { barcode: string; from: string }[] = [];
		const unchanged: { barcode: string; reason: string }[] = [];
		const rejected: { barcode: string; reason: string }[] = [];
		const suffix = reason ? ` — ${reason}` : '';

		for (const barcode of barcodes) {
			const cart = (await CartridgeRecord.findById(barcode).select('_id status').lean()) as
				| { _id: string; status?: string }
				| null;

			if (!cart) {
				if (!createUnknown) {
					rejected.push({ barcode, reason: 'unknown barcode — not in the system' });
					continue;
				}
				try {
					await CartridgeRecord.create({
						_id: barcode,
						status: target,
						statusUpdatedOn: now.toISOString(),
						notes: [
							{
								_id: generateId(),
								body: `Originated by State Change (new → ${target})${suffix}.`,
								phase: 'state-change',
								author: op,
								createdAt: now
							}
						]
					});
					await AuditLog.create({
						_id: generateId(),
						tableName: 'cartridge_records',
						recordId: barcode,
						action: 'state_change',
						newData: { from: 'new', to: target, originated: true, reason: reason || undefined },
						changedAt: now,
						changedBy: op.username
					});
					changed.push({ barcode, from: 'new' });
				} catch (e: unknown) {
					// Duplicate-key race (created between findById and create) or any
					// other write error — surface it, keep the barcode to re-scan.
					const code = (e as { code?: number })?.code;
					rejected.push({
						barcode,
						reason: code === 11000 ? 'already exists — re-scan' : 'could not originate'
					});
				}
				continue;
			}

			const from = cart.status ?? 'none';
			if (from === target && !clearReagentFill) {
				unchanged.push({ barcode, reason: `already ${target}` });
				continue;
			}

			const set: Record<string, unknown> = {
				status: target,
				priorStatus: from,
				statusUpdatedOn: now.toISOString()
			};
			// Opt-in: wipe any prior reagent fill so the "already reagent-filled"
			// guard on the Reagent Filling page doesn't reject a reused cart.
			if (clearReagentFill) set.reagentFilling = { tubeRecords: [] };

			await CartridgeRecord.updateOne(
				{ _id: barcode },
				{
					$set: set,
					$push: {
						notes: {
							_id: generateId(),
							body: `State Change: ${from} → ${target}${
								clearReagentFill ? ', reagent fill cleared' : ''
							}${suffix}.`,
							phase: 'state-change',
							author: op,
							createdAt: now
						}
					}
				}
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: barcode,
				action: 'state_change',
				newData: {
					from,
					to: target,
					reagentFillCleared: clearReagentFill || undefined,
					reason: reason || undefined
				},
				changedAt: now,
				changedBy: op.username
			});
			changed.push({ barcode, from });
		}

		return { success: true, target, changed, unchanged, rejected };
	}
};
