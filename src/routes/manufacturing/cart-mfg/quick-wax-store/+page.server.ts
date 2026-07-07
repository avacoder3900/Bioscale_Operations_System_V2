/**
 * Quick Wax Store shortcut (QUICK-WAX-STORE-FOR-PIC.md).
 *
 * Bulk-scan cartridge barcodes and land them all at `wax_stored` — the state a
 * cartridge sits in right before its wax QC photo is taken on Wax Inspect
 * (wax_stored → photo → wax_qc → wax_ready | wax_rejected).
 *
 * Unlike Quick Seal / Quick Reagent Fill Test, this ACCEPTS BARCODES THAT DON'T
 * EXIST YET: a not-found barcode is CREATED as a fresh cartridge at wax_stored so
 * you can conjure test carts on the fly. A barcode that already exists is advanced
 * to wax_stored from wherever it was. Every cart gets a "Quick Wax Store" note, the
 * `usedForTestFill` marker, `priorStatus`, and an AuditLog row.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [total, waxStored] = await Promise.all([
		CartridgeRecord.estimatedDocumentCount(),
		CartridgeRecord.countDocuments({ status: 'wax_stored' })
	]);
	return { counts: { total, wax_stored: waxStored } };
};

export const actions: Actions = {
	store: async ({ request, locals }) => {
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
		const created: string[] = [];
		const advanced: { barcode: string; from: string }[] = [];
		const failed: { barcode: string; reason: string }[] = [];

		for (const barcode of barcodes) {
			try {
				const cart = (await CartridgeRecord.findById(barcode).select('_id status').lean()) as any;

				if (!cart) {
					// Barcode doesn't exist yet → originate a fresh cart straight at wax_stored.
					await CartridgeRecord.create({
						_id: barcode,
						status: 'wax_stored',
						priorStatus: '(created)',
						usedForTestFill: true,
						notes: [
							{
								_id: generateId(),
								body: 'Created via Quick Wax Store (originated at wax_stored, ready for wax QC photo).',
								phase: 'wax_stored',
								author: op,
								createdAt: now
							}
						]
					});
					await AuditLog.create({
						_id: generateId(),
						tableName: 'cartridge_records',
						recordId: barcode,
						action: 'quick_wax_store',
						newData: { from: '(created)', to: 'wax_stored', created: true },
						changedAt: now,
						changedBy: op.username
					});
					created.push(barcode);
					continue;
				}

				const from = cart.status ?? 'none';
				await CartridgeRecord.updateOne(
					{ _id: barcode },
					{
						$set: { status: 'wax_stored', priorStatus: from, usedForTestFill: true },
						$push: {
							notes: {
								_id: generateId(),
								body: `Quick Wax Store shortcut: ${from} → wax_stored (ready for wax QC photo).`,
								phase: 'wax_stored',
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
					action: 'quick_wax_store',
					newData: { from, to: 'wax_stored', created: false },
					changedAt: now,
					changedBy: op.username
				});
				advanced.push({ barcode, from });
			} catch (e) {
				failed.push({ barcode, reason: e instanceof Error ? e.message : 'update failed' });
			}
		}

		return { success: true, created, advanced, failed };
	}
};
