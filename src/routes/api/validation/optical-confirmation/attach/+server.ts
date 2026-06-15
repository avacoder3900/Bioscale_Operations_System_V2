import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, Spu, LabCartridge, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'spu:write');
	await connectDB();

	const { spuId, cartridgeBarcode } = await request.json();
	if (!spuId || !cartridgeBarcode) return json({ error: 'spuId and cartridgeBarcode are required' }, { status: 400 });

	const spu = await Spu.findById(spuId);
	if (!spu) return json({ error: 'SPU not found' }, { status: 404 });
	if (spu.finalizedAt) return json({ error: 'SPU finalized - use corrections' }, { status: 400 });
	if (spu.validation?.opticalConfirmation?.labCartridgeId) return json({ error: 'Optical confirmation cartridge already attached' }, { status: 400 });

	const cartridge = await LabCartridge.findOne({ barcode: cartridgeBarcode, cartridgeType: 'optical_test' });
	if (!cartridge) return json({ error: 'No captured optical-test cartridge for that barcode' }, { status: 400 });
	if (cartridge.status !== 'available') return json({ error: 'Cartridge is ' + cartridge.status }, { status: 400 });
	if (cartridge.expirationDate && cartridge.expirationDate < new Date()) return json({ error: 'Cartridge expired' }, { status: 400 });

	const operator = { _id: locals.user._id, username: locals.user.username };
	const now = new Date();
	if (!spu.validation) spu.validation = {};
	spu.validation.opticalConfirmation = {
		status: 'pending', labCartridgeId: cartridge._id, cartridgeBarcode,
		assay: cartridge.assay, attachedAt: now, attachedBy: operator
	};
	spu.markModified('validation.opticalConfirmation');
	await spu.save();

	cartridge.status = 'in_use';
	cartridge.usageLog.push({ action: 'used', spuId: spu._id, performedBy: operator, performedAt: now });
	await cartridge.save();

	await AuditLog.create({
		tableName: 'spus', recordId: spu._id, action: 'UPDATE',
		newData: { opticalConfirmation: { labCartridgeId: cartridge._id, cartridgeBarcode } },
		changedBy: locals.user._id, changedAt: now, reason: 'Attach optical confirmation cartridge'
	});

	return json({ success: true });
};
