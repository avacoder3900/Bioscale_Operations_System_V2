import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, LabCartridge, AssayDefinition, AuditLog, generateId } from '$lib/server/db';
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

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	const { barcode, serialNumber, lotNumber, assaySkuCode, expirationDate } = await request.json();
	if (!barcode || !assaySkuCode) return json({ error: 'barcode and assaySkuCode are required' }, { status: 400 });

	const existing = await LabCartridge.findOne({ barcode }).select('status cartridgeType').lean();
	if (existing) return json({ error: `Cartridge ${barcode} already captured (type: ${(existing as any).cartridgeType}, status: ${(existing as any).status})` }, { status: 400 });

	const assay = await AssayDefinition.findOne({ skuCode: assaySkuCode, isActive: { $ne: false } });
	if (!assay) return json({ error: `Assay '${assaySkuCode}' not found (or inactive)` }, { status: 400 });

	try {
		const operator = { _id: locals.user._id, username: locals.user.username };
		const cartridge = await LabCartridge.create({
			_id: generateId(),
			barcode, serialNumber, lotNumber,
			expirationDate: expirationDate ? new Date(expirationDate) : undefined,
			cartridgeType: 'optical_test',
			status: 'available',
			assay: { _id: assay._id, name: assay.name, skuCode: assay.skuCode },
			notes: 'Optical confirmation assay ' + assay.skuCode + ' - captured as wax cartridge (off standard workflow)',
			usageLog: [{ action: 'registered', newValue: assay.skuCode, performedBy: operator, performedAt: new Date() }],
			createdBy: locals.user._id
		});

		await AuditLog.create({
			tableName: 'lab_cartridges', recordId: cartridge._id, action: 'INSERT',
			newData: { barcode, cartridgeType: 'optical_test', assay: assay.skuCode },
			changedBy: locals.user._id, changedAt: new Date(), reason: 'Capture optical-test cartridge'
		});

		return json({ success: true, cartridge: JSON.parse(JSON.stringify(cartridge)) });
	} catch (err) {
		return json({ error: err instanceof Error ? err.message : 'Failed to save cartridge' }, { status: 500 });
	}
};
