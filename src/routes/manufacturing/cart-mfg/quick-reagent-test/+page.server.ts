/**
 * Quick Reagent Fill Test shortcut (QUICK-REAGENT-FILL-TEST.md).
 *
 * Bulk-scan cartridge barcodes at ANY status and make them reagent-fillable:
 * set status → `wax_ready` (the reagent-fill intake gate) and clear any prior
 * `reagentFilling` so a cart that was already reagent-filled passes the
 * "already reagent-filled" guard on the next scan. Every converted cart gets a
 * "Used for test fill" note, a `usedForTestFill` marker, `priorStatus`, and an
 * AuditLog row.
 *
 * Unlike Quick Seal, this accepts EVERY existing cartridge regardless of status —
 * that is the whole point: grab any carts on hand and reuse them for a test fill.
 * A not-found barcode is not rejected either: it is ORIGINATED as a brand-new
 * cartridge directly at wax_ready so a never-before-seen barcode still works.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [total, waxReady, reagentFilled] = await Promise.all([
		CartridgeRecord.estimatedDocumentCount(),
		CartridgeRecord.countDocuments({ status: 'wax_ready' }),
		CartridgeRecord.countDocuments({ status: 'reagent_filled' })
	]);
	return { counts: { total, wax_ready: waxReady, reagent_filled: reagentFilled } };
};

export const actions: Actions = {
	convert: async ({ request, locals }) => {
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
		const converted: { barcode: string; from: string }[] = [];
		const rejected: { barcode: string; reason: string }[] = [];

		for (const barcode of barcodes) {
			const cart = (await CartridgeRecord.findById(barcode).select('_id status').lean()) as any;
			if (!cart) {
				// Never-before-seen barcode: originate a brand-new cartridge directly
				// at wax_ready (the reagent-fill intake gate) so it can be used for a
				// test fill without having gone through wax/backing first. Created,
				// not rejected.
				try {
					await CartridgeRecord.create({
						_id: barcode,
						status: 'wax_ready',
						usedForTestFill: true,
						reagentFilling: { tubeRecords: [] },
						notes: [
							{
								_id: generateId(),
								body: 'Originated for test fill (Quick Reagent Fill Test: new → wax_ready).',
								phase: 'test-fill',
								author: op,
								createdAt: now
							}
						]
					});
					await AuditLog.create({
						_id: generateId(),
						tableName: 'cartridge_records',
						recordId: barcode,
						action: 'quick_reagent_test',
						newData: { from: 'new', to: 'wax_ready', originated: true },
						changedAt: now,
						changedBy: op.username
					});
					converted.push({ barcode, from: 'new' });
				} catch (e: any) {
					// Duplicate-key race (created between findById and create) or any
					// other write error — surface it, keep the barcode to re-scan.
					rejected.push({ barcode, reason: e?.code === 11000 ? 'already exists — re-scan' : 'could not originate' });
				}
				continue;
			}
			const from = cart.status ?? 'none';
			await CartridgeRecord.updateOne(
				{ _id: barcode },
				{
					$set: {
						status: 'wax_ready',
						priorStatus: from,
						usedForTestFill: true,
						// Clear any prior reagent fill so the "already reagent-filled"
						// guard on the Reagent Filling page doesn't reject a reused cart.
						reagentFilling: { tubeRecords: [] }
					},
					$push: {
						notes: {
							_id: generateId(),
							body: `Used for test fill (Quick Reagent Fill Test: ${from} → wax_ready, reagent fill cleared).`,
							phase: 'test-fill',
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
				action: 'quick_reagent_test',
				newData: { from, to: 'wax_ready' },
				changedAt: now,
				changedBy: op.username
			});
			converted.push({ barcode, from });
		}

		return { success: true, converted, rejected };
	}
};
