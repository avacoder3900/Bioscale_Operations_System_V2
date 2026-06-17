import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, mongoose, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Assign an assay ID to existing cartridge_records documents (found by _id = scanned barcode).
// Sets assayId only; re-reads from Mongo as proof.
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	const body = await request.json();
	const rawList: string[] = Array.isArray(body.barcodes) ? body.barcodes : body.barcode ? [body.barcode] : [];
	const barcodes = [...new Set(rawList.map((b) => String(b).trim()).filter(Boolean))];
	if (barcodes.length === 0) return json({ error: 'Provide at least one barcode' }, { status: 400 });

	const assayId = (body.assayId ?? '').toString().trim();
	if (!assayId) return json({ error: 'Assay ID is required' }, { status: 400 });

	const db = mongoose.connection.db;
	const col = db.collection('cartridge_records');
	const now = new Date();
	const updated: string[] = [];
	const skipped: { barcode: string; reason: string }[] = [];

	for (const barcode of barcodes) {
		try {
			const res = await col.updateOne(
				{ _id: barcode as any },
				{ $set: { assayId, assayCategory: 'optical_test', assayCategorizedAt: now, assayCategorizedBy: locals.user._id } }
			);
			if (res.matchedCount === 0) skipped.push({ barcode, reason: `no cartridge_records doc with _id "${barcode}"` });
			else updated.push(barcode);
		} catch (err) {
			skipped.push({ barcode, reason: err instanceof Error ? err.message : 'update failed' });
		}
	}

	const verified = updated.length
		? await col.find({ _id: { $in: updated as any } }).project({ _id: 1, assayId: 1, assayCategory: 1, status: 1 }).toArray()
		: [];

	if (updated.length > 0) {
		await AuditLog.create({
			tableName: 'cartridge_records',
			recordId: 'batch',
			action: 'UPDATE',
			newData: { assayId, count: updated.length, barcodes: updated },
			changedBy: locals.user._id,
			changedAt: now,
			reason: 'Assign assay to cartridges (set assayId)'
		});
	}

	return json({ success: true, dbName: db.databaseName, updated: updated.length, skipped, verified: JSON.parse(JSON.stringify(verified)), assayId });
};
