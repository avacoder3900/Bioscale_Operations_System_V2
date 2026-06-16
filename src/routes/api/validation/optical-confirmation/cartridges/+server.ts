import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, LabCartridge, ManufacturingSettings, CartridgeGroup, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

// Live status check for a barcode so the UI can tell the operator whether it is free or already used.
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();
	const barcode = url.searchParams.get('barcode')?.trim();
	if (!barcode) return json({ exists: false });
	const c = await LabCartridge.findOne({ barcode }).select('status cartridgeType assay').lean();
	if (!c) return json({ exists: false });
	return json({
		exists: true,
		status: (c as any).status ?? null,
		cartridgeType: (c as any).cartridgeType ?? null,
		used: (c as any).status !== 'available',
		assaySkuCode: (c as any).assay?.skuCode ?? null
	});
};

// Batch-register optical-test cartridges. Every cartridge gets the preset optical-confirmation
// assay (from settings) and is assigned to a validation group (CartridgeGroup). Accepts a list of
// barcodes (or a single `barcode` for back-compat).
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	const body = await request.json();
	const rawList: string[] = Array.isArray(body.barcodes) ? body.barcodes : body.barcode ? [body.barcode] : [];
	const barcodes = [...new Set(rawList.map((b) => String(b).trim()).filter(Boolean))];
	if (barcodes.length === 0) return json({ error: 'Provide at least one barcode' }, { status: 400 });

	// Preset assay — set once by an admin on the Criteria page.
	const settings = await ManufacturingSettings.findById('default').select('opticalConfirmation').lean();
	const presetAssay = (settings as any)?.opticalConfirmation?.assay;
	if (!presetAssay?.skuCode) {
		return json({ error: 'No optical-confirmation assay is configured. Set it on the Criteria page first.' }, { status: 400 });
	}

	// Resolve the validation group: use an existing groupId, or create one from groupName.
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
		if (!grp) return json({ error: 'Validation group not found' }, { status: 400 });
		groupName = grp.name;
	}

	const operator = { _id: locals.user._id, username: locals.user.username };
	const now = new Date();
	const created: { _id: string; barcode: string }[] = [];
	const skipped: { barcode: string; reason: string }[] = [];

	for (const barcode of barcodes) {
		const existing = await LabCartridge.findOne({ barcode }).select('status cartridgeType').lean();
		if (existing) {
			skipped.push({ barcode, reason: `already exists (${(existing as any).cartridgeType}/${(existing as any).status})` });
			continue;
		}
		try {
			const cartridge = await LabCartridge.create({
				_id: generateId(),
				barcode,
				cartridgeType: 'optical_test',
				status: 'available',
				groupId,
				assay: { _id: presetAssay._id, name: presetAssay.name, skuCode: presetAssay.skuCode },
				notes: 'Optical confirmation assay ' + presetAssay.skuCode + (groupName ? ' - group ' + groupName : '') + ' - off standard workflow',
				usageLog: [{ action: 'registered', newValue: presetAssay.skuCode, performedBy: operator, performedAt: now }],
				createdBy: locals.user._id
			});
			created.push({ _id: cartridge._id, barcode });
		} catch (err) {
			skipped.push({ barcode, reason: err instanceof Error ? err.message : 'save failed' });
		}
	}

	if (created.length > 0) {
		await AuditLog.create({
			tableName: 'lab_cartridges', recordId: groupId ?? 'batch', action: 'INSERT',
			newData: { count: created.length, assay: presetAssay.skuCode, groupId, groupName, barcodes: created.map((c) => c.barcode) },
			changedBy: locals.user._id, changedAt: now, reason: 'Batch-capture optical-test cartridges'
		});
	}

	return json({ success: true, created, skipped, groupId, groupName, assay: presetAssay });
};
