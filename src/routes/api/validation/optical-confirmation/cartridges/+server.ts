import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, LabCartridge, AssayDefinition, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'cartridge:write');
	await connectDB();

	const { barcode, serialNumber, lotNumber, assaySkuCode, expirationDate } = await request.json();
	if (!barcode || !assaySkuCode) return json({ error: 'barcode and assaySkuCode are required' }, { status: 400 });

	if (await LabCartridge.findOne({ barcode })) return json({ error: 'Cartridge already captured' }, { status: 400 });

	const assay = await AssayDefinition.findOne({ skuCode: assaySkuCode, isActive: true });
	if (!assay) return json({ error: 'Optical confirmation assay not found' }, { status: 400 });

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
};
