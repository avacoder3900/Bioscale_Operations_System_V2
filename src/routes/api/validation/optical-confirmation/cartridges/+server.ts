import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, mongoose, CartridgeGroup, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Status check: is the cartridge_records doc for this barcode "linked" + which assayId?
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) return json({ exists: false });
	const col = mongoose.connection.db.collection('cartridge_records');
	const c = await col.findOne({ _id: barcode as any }, { projection: { assayId: 1, status: 1, serialNumber: 1 } });
	if (!c) return json({ exists: false });
	return json({ exists: true, assayId: (c as any).assayId ?? null, status: (c as any).status ?? null, serialNumber: (c as any).serialNumber ?? null });
};

// Make cartridges runnable on the SPU by writing the research/SPU cartridge shape onto their
// cartridge_records docs (status: 'linked' + assayId + serialNumber + checkpoints). The SPU keys off
// these fields — assayId alone is not enough. Upserts by _id = scanned barcode.
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

	// Resolve the validation group (optional).
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

	const db = mongoose.connection.db;
	const dbName = db.databaseName;
	const col = db.collection('cartridge_records');

	// Friendly assay name from the catalog (research docs leave it blank, but nice to have).
	const assayDef = await db.collection('assay_definitions').findOne({ _id: assayId as any }, { projection: { name: 1 } });
	const assayName = (assayDef as any)?.name ?? '';

	const now = new Date();
	const nowIso = now.toISOString();
	const who = (locals.user as any).username || (locals.user as any).email || locals.user._id;
	const checkpoint = { who, when: nowIso, where: { city_name: 'Houston' } };
	const expirationDate = new Date(now.getTime() + 4 * 365 * 24 * 3600 * 1000).toISOString();
	const serialMiddle = (now.getTime() % 1e11).toString().padStart(11, '0');

	const updated: string[] = [];
	const skipped: { barcode: string; reason: string }[] = [];

	for (let i = 0; i < barcodes.length; i++) {
		const barcode = barcodes[i];
		const serialNumber = `${assayId}-${serialMiddle}-${String(i + 1).padStart(3, '0')}`;
		try {
			await col.updateOne(
				{ _id: barcode as any },
				{
					$set: {
						status: 'linked',
						statusUpdatedOn: nowIso,
						assayId,
						assayName,
						serialNumber,
						checkpoints: { created: checkpoint, linked: checkpoint },
						quantity: 0,
						expirationDate,
						// BIMS-side categorization
						assayCategory: 'optical_test',
						validationGroupId: groupId ?? null
					},
					$setOnInsert: {
						validationErrors: [],
						photos: [],
						reagentChain: [],
						corrections: [],
						photoSequence: 0
					}
				},
				{ upsert: true }
			);
			updated.push(barcode);
		} catch (err) {
			skipped.push({ barcode, reason: err instanceof Error ? err.message : 'update failed' });
		}
	}

	// Re-read from cartridge_records (proof the docs are now in the runnable shape).
	const verified = updated.length
		? await col
				.find({ _id: { $in: updated as any } })
				.project({ _id: 1, status: 1, assayId: 1, serialNumber: 1, assayCategory: 1, validationGroupId: 1 })
				.toArray()
		: [];

	if (updated.length > 0) {
		await AuditLog.create({
			tableName: 'cartridge_records',
			recordId: groupId ?? 'batch',
			action: 'UPDATE',
			newData: { assayId, status: 'linked', count: updated.length, groupId, groupName, barcodes: updated },
			changedBy: locals.user._id,
			changedAt: now,
			reason: 'Make cartridges runnable (research/SPU shape: status linked + assayId + serialNumber)'
		});
	}

	return json({
		success: true,
		dbName,
		updated: updated.length,
		skipped,
		verified: JSON.parse(JSON.stringify(verified)),
		assayId,
		assayName,
		groupId,
		groupName
	});
};
