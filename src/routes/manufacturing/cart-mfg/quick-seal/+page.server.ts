/**
 * Quick-Seal shortcut (QUICK-SEAL-WAXQC-TO-SEALED.md).
 *
 * Bulk-scan cartridge barcodes and move them from the wax stage
 * (wax_filled / wax_ready, plus legacy wax_qc) straight to `sealed` — the state
 * right before the reagent picture. Shortcuts reagent_filling → reagent_filled →
 * sealed for a workflow where those steps are handled outside BIMS.
 *
 * WAX-SIMPLIFY: wax_filled is accepted (it is the wax-stage resting state now).
 * Any other status (or not-found) is rejected per-cart and reported; valid carts
 * in the same batch still process.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import { WAX_STAGE_STATUSES } from '$lib/shared/cartridge-wax-status';
import type { PageServerLoad, Actions } from './$types';

const ACCEPTED = new Set<string>([...WAX_STAGE_STATUSES, 'wax_qc']);

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [waxFilled, waxQc, waxReady] = await Promise.all([
		CartridgeRecord.countDocuments({ status: 'wax_filled' }),
		CartridgeRecord.countDocuments({ status: 'wax_qc' }),
		CartridgeRecord.countDocuments({ status: 'wax_ready' })
	]);
	return { eligible: { wax_filled: waxFilled, wax_qc: waxQc, wax_ready: waxReady, total: waxFilled + waxQc + waxReady } };
};

export const actions: Actions = {
	seal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const raw = (data.get('barcodes') as string) ?? '';
		// Split on any whitespace/newlines (scanner sends barcode + Enter), trim, dedup.
		const barcodes = Array.from(
			new Set(raw.split(/\s+/).map((s) => s.trim()).filter(Boolean))
		);
		if (barcodes.length === 0) return fail(400, { error: 'Scan at least one cartridge barcode' });

		const op = { _id: locals.user._id, username: locals.user.username };
		const now = new Date();
		const sealed: string[] = [];
		const rejected: { barcode: string; reason: string }[] = [];

		for (const barcode of barcodes) {
			const cart = (await CartridgeRecord.findById(barcode).select('_id status').lean()) as any;
			if (!cart) {
				rejected.push({ barcode, reason: 'not found' });
				continue;
			}
			if (!ACCEPTED.has(cart.status)) {
				rejected.push({ barcode, reason: `status=${cart.status ?? 'none'} (need wax_qc or wax_ready)` });
				continue;
			}
			await CartridgeRecord.updateOne(
				{ _id: barcode },
				{
					$set: {
						status: 'sealed',
						priorStatus: cart.status,
						topSeal: { operator: op, timestamp: now, recordedAt: now }
					},
					$push: {
						notes: {
							_id: generateId(),
							body: `Quick-Seal shortcut: ${cart.status} → sealed (skipped verdict / reagent-fill steps).`,
							phase: 'sealed',
							author: op.username,
							createdAt: now
						}
					}
				}
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: barcode,
				action: 'quick_seal',
				newData: { from: cart.status, to: 'sealed' },
				changedAt: now,
				changedBy: op.username
			});
			sealed.push(barcode);
		}

		return { success: true, sealed, rejected };
	}
};
