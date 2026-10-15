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
 *  - Bucket stages (barcoded / unpressed / backing) are bucket MEMBERSHIP, not just a
 *    status: moving a cart into one needs a destination bucket whose open pass
 *    is at that stage, and moving a cart out of one removes it from its pass.
 *    Both go through bucket-service.overrideCartStage so the board stays honest.
 *    No inventory moves either way. Unknown barcodes cannot be created at a
 *    bucket stage — scanning into a bucket on the board is what debits parts.
 *  - "No bucket" (shown only when the target is Backed) moves the carts straight
 *    to status 'backing' on no pass — where Move to oven leaves carts: counted as
 *    Backed, listed in the board's "In oven" dropdown, loadable by wax filling.
 *    They leave their current pass if they are in one. Unknown barcodes are still
 *    refused.
 *  - Badge (2026-10-05): a cart entering or leaving a bucket pass is a
 *    badge-gated bucket step, like the board's. The badge is resolved once per
 *    batch and only if a cart actually takes the bucket path; plain status
 *    changes on carts outside the buckets stay on the session. A BDG- code
 *    scanned into the cart box is taken as the badge, never as a cartridge.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import { resolveBucketId, overrideCartStage, badgeGate, boardData, isBucketStage, isBucketStatus, BucketError, BUCKET_STAGES, BACKED_STAGE, STAGE_LABELS, type BadgeGate } from '$lib/server/services/bucket-service';
import { badgeMode, isBadgeCode } from '$lib/server/services/badge-service';
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

	const [total, byStatus, board, badge] = await Promise.all([
		CartridgeRecord.estimatedDocumentCount(),
		CartridgeRecord.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
		boardData().catch(() => ({ cycles: [] as any[] })),
		badgeMode().catch(() => 'required' as const)
	]);

	const counts: Record<string, number> = {};
	for (const row of byStatus as { _id: string | null; n: number }[]) {
		if (row._id) counts[row._id] = row.n;
	}

	return {
		badgeMode: badge,
		statuses: statusList(),
		total,
		counts,
		bucketStages: [...BUCKET_STAGES] as string[],
		backedStage: BACKED_STAGE as string, // the one bucket stage that allows "No bucket"
		stageLabels: STAGE_LABELS as Record<string, string>,
		// Open passes, for the destination picker when the target is a bucket stage.
		openPasses: board.cycles.map((c: any) => ({
			cycleId: c.cycleId, bucketId: c.bucketId, barcode: c.barcode ?? null, cycleNumber: c.cycleNumber, stage: c.stage, quantity: c.quantity
		}))
	};
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
		const destinationBucketId = ((data.get('destinationBucketId') as string) ?? '').trim();
		// Straight to Backed on no pass — only meaningful for the Backed target.
		const noBucket = data.get('noBucket') === 'on' && target === BACKED_STAGE;

		if (!statusList().includes(target)) {
			return fail(400, { error: `Pick a target status (got "${target || 'none'}")` });
		}
		if (isBucketStage(target) && !destinationBucketId && !noBucket) {
			return fail(400, { error: `${STAGE_LABELS[target]} is a bucket stage — pick the destination bucket (its open pass must be at ${STAGE_LABELS[target]}).` });
		}

		// Split on any whitespace/newlines (scanner sends barcode + Enter), trim, dedup.
		const scannedCodes = Array.from(
			new Set(raw.split(/\s+/).map((s) => s.trim()).filter(Boolean))
		);
		// A badge scanned into the cart box is the badge, never a cartridge — with
		// "Create unknown barcodes" ticked it would otherwise be originated as one.
		const barcodes = scannedCodes.filter((c) => !isBadgeCode(c));
		const badge = ((data.get('badge') as string) ?? '').trim() || scannedCodes.find((c) => isBadgeCode(c)) || '';
		if (barcodes.length === 0) return fail(400, { error: 'Scan at least one cartridge barcode' });

		const op = { _id: locals.user._id, username: locals.user.username };
		// Bucket moves are badge-gated (2026-10-05). One lookup for the whole batch,
		// made only when a cart actually enters or leaves a bucket pass.
		let gate: Promise<BadgeGate> | null = null;
		const bucketGate = () => (gate ??= badgeGate(badge, op));
		if (isBucketStage(target)) {
			// Every cart in this batch takes the bucket path: refuse once, up front,
			// instead of rejecting each cart with the same badge message.
			try {
				await bucketGate();
			} catch (e) {
				if (e instanceof BucketError) return fail(e.status, { error: e.message, code: e.code ?? null });
				throw e;
			}
		}
		const now = new Date();
		const changed: { barcode: string; from: string }[] = [];
		const unchanged: { barcode: string; reason: string }[] = [];
		const rejected: { barcode: string; reason: string }[] = [];
		const suffix = reason ? ` — ${reason}` : '';

		for (const barcode of barcodes) {
			const cart = (await CartridgeRecord.findById(barcode).select('_id status').lean()) as
				| { _id: string; status?: string }
				| null;

			// Bucket-aware path: into a bucket stage, or out of one (the cart is a
			// member of an open pass). Membership + status move together.
			if (cart && (isBucketStage(target) || isBucketStatus(cart.status))) { // legacy 'pressed' members leave their pass too
				try {
					const r = await overrideCartStage({ barcode, target, destinationBucketId: noBucket ? undefined : destinationBucketId || undefined, noBucket, reason, gate: await bucketGate(), user: op });
					if (r.from === r.to && r.fromCycle === r.toCycle) unchanged.push({ barcode, reason: `already ${target}${r.toCycle ? ' in that bucket' : noBucket ? ' (no bucket)' : ''}` });
					else changed.push({ barcode, from: r.from });
				} catch (e) {
					rejected.push({ barcode, reason: e instanceof BucketError ? e.message : 'override failed' });
				}
				continue;
			}
			if (!cart && isBucketStage(target)) {
				rejected.push({ barcode, reason: 'unknown barcode — scan it into a bucket on the board (that is what debits its shell + label)' });
				continue;
			}

			if (!cart) {
				if (!createUnknown) {
					rejected.push({ barcode, reason: 'unknown barcode — not in the system' });
					continue;
				}
				// A production bucket wearing a UUID QR sticker scans exactly like a
				// cartridge (BUCKET-SYSTEM_PLAN §9.4). Refuse it here, outside the
				// try, so the operator sees why instead of "could not originate".
				const bucketId = await resolveBucketId(barcode);
				if (bucketId) {
					rejected.push({ barcode, reason: `label on production bucket ${bucketId} — not a cartridge` });
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
