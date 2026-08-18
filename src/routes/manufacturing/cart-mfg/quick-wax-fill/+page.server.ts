/**
 * Quick Wax Fill Test shortcut.
 *
 * Bulk-scan cartridge barcodes and land them all at `wax_filled` — the wax-stage
 * resting state (WAX-SIMPLIFY-1: wax_filled IS stored; visual pass is implicit,
 * rejects go through Wax Reject → wax_rejected; wax_filled | wax_ready → reagent).
 * Quick Wax Store was folded into this page.
 *
 * This ACCEPTS BARCODES THAT DON'T EXIST YET: a not-found
 * barcode is CREATED as a fresh cartridge at wax_filled so you can conjure test
 * carts on the fly. A barcode that already exists is moved to wax_filled from
 * wherever it was. Every cart gets a "Quick Wax Fill" note, the `usedForTestFill`
 * marker, `priorStatus`, and an AuditLog row.
 */
import { fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [total, waxFilled] = await Promise.all([
		CartridgeRecord.estimatedDocumentCount(),
		CartridgeRecord.countDocuments({ status: 'wax_filled' })
	]);
	return { counts: { total, wax_filled: waxFilled } };
};

export const actions: Actions = {
	fill: async ({ request, locals }) => {
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
					// Barcode doesn't exist yet → originate a fresh cart straight at wax_filled.
					await CartridgeRecord.create({
						_id: barcode,
						status: 'wax_filled',
						priorStatus: '(created)',
						usedForTestFill: true,
						notes: [
							{
								_id: generateId(),
								body: 'Created via Quick Wax Fill (originated at wax_filled, ready to be stored).',
								phase: 'wax_filled',
								author: op,
								createdAt: now
							}
						]
					});
					await AuditLog.create({
						_id: generateId(),
						tableName: 'cartridge_records',
						recordId: barcode,
						action: 'quick_wax_fill',
						newData: { from: '(created)', to: 'wax_filled', created: true },
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
						$set: { status: 'wax_filled', priorStatus: from, usedForTestFill: true },
						$push: {
							notes: {
								_id: generateId(),
								body: `Quick Wax Fill shortcut: ${from} → wax_filled (ready to be stored).`,
								phase: 'wax_filled',
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
					action: 'quick_wax_fill',
					newData: { from, to: 'wax_filled', created: false },
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
