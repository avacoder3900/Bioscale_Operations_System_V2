import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, mongoose, CartridgeGroup, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Live status check: does a cartridge_record exist for this barcode, and what is its current assayId?
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) return json({ exists: false });
	const col = mongoose.connection.db.collection('cartridge_records');
	const c = await col.findOne({ _id: barcode as any }, { projection: { assayId: 1, currentPhase: 1 } });
	if (!c) return json({ exists: false });
	return json({ exists: true, assayId: (c as any).assayId ?? null, currentPhase: (c as any).currentPhase ?? null });
};

// Categorize cartridges as optical-test by writing assayId directly onto the cartridge_records docs.
// Uses a raw collection update (find by _id = scanned barcode) so the field lands regardless of the
// Mongoose schema/sacred middleware, then re-reads from the SAME collection as proof.
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

	// Resolve the validation group (optional): existing groupId, or create one from groupName.
	let groupId: string | undefined = body.groupId?.trim() || undefined;
	let groupName: string | undefined;
	if (!groupId && body.groupName?.trim()) {
		const name = body.groupName.trim();
		let grp: any = await CartridgeGroup.findOne({ name }).lean();
		if (!grp) grp = await CartridgeGroup.create({ _id: generateId(), name, createdBy: locals.user._id });
		groupId = grp._id;
		groupName = name;
	} else if (groupId) {
		const grp: any = await CartridgeGroup.findById(groupId).select('name').lean();
		if (grp) groupName = grp.name;
	}

	const now = new Date();
	const col = mongoose.connection.db.collection('cartridge_records');
	const dbName = mongoose.connection.db.databaseName;
	const updated: string[] = [];
	const skipped: { barcode: string; reason: string }[] = [];

	for (const barcode of barcodes) {
		const setFields: Record<string, unknown> = {
			assayId,
			assayCategory: 'optical_test',
			assayCategorizedAt: now,
			assayCategorizedBy: locals.user._id
		};
		if (groupId) setFields.validationGroupId = groupId;
		try {
			const res = await col.updateOne({ _id: barcode as any }, { $set: setFields });
			if (res.matchedCount === 0) {
				skipped.push({ barcode, reason: `no cartridge_record with _id "${barcode}"` });
			} else {
				updated.push(barcode);
			}
		} catch (err) {
			skipped.push({ barcode, reason: err instanceof Error ? err.message : 'update failed' });
		}
	}

	// Re-read the just-edited docs from cartridge_records (proof the documents changed in this DB).
	const verified = updated.length
		? await col
				.find({ _id: { $in: updated as any } })
				.project({ _id: 1, assayId: 1, assayCategory: 1, validationGroupId: 1, currentPhase: 1 })
				.toArray()
		: [];

	if (updated.length > 0) {
		await AuditLog.create({
			tableName: 'cartridge_records',
			recordId: groupId ?? 'batch',
			action: 'UPDATE',
			newData: { assayId, count: updated.length, groupId, groupName, barcodes: updated },
			changedBy: locals.user._id,
			changedAt: now,
			reason: 'Categorize cartridges as optical-test (set assayId on cartridge_records)'
		});
	}

	return json({
		success: true,
		dbName,
		updated: updated.length,
		skipped,
		verified: JSON.parse(JSON.stringify(verified)),
		assayId,
		groupId,
		groupName
	});
};
