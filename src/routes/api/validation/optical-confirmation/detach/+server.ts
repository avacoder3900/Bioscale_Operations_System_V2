import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { connectDB, Spu, LabCartridge, AuditLog } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';

export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });
	requirePermission(locals.user, 'spu:write');
	await connectDB();

	const { spuId, reason } = await request.json();
	if (!spuId || !reason) return json({ error: 'spuId and reason are required' }, { status: 400 });

	const spu = await Spu.findById(spuId);
	if (!spu) return json({ error: 'SPU not found' }, { status: 404 });
	if (spu.finalizedAt) return json({ error: 'SPU finalized - use corrections' }, { status: 400 });
	const oc = spu.validation?.opticalConfirmation;
	if (!oc?.labCartridgeId) return json({ error: 'No optical confirmation cartridge attached' }, { status: 400 });

	const operator = { _id: locals.user._id, username: locals.user.username };
	const now = new Date();
	const labCartridgeId = oc.labCartridgeId;

	const cartridge = await LabCartridge.findById(labCartridgeId);
	if (cartridge) {
		cartridge.status = 'quarantine';
		cartridge.usageLog.push({ action: 'returned', spuId: spu._id, notes: reason, performedBy: operator, performedAt: now });
		await cartridge.save();
	}

	const ocPath = spu.validation.opticalConfirmation;
	ocPath.status = 'pending';
	ocPath.labCartridgeId = undefined;
	ocPath.cartridgeBarcode = undefined;
	ocPath.assay = undefined;
	ocPath.attachedAt = undefined;
	ocPath.attachedBy = undefined;
	spu.markModified('validation.opticalConfirmation');
	await spu.save();

	await AuditLog.create({
		tableName: 'spus', recordId: spu._id, action: 'UPDATE',
		oldData: { opticalConfirmation: { labCartridgeId } },
		changedBy: locals.user._id, changedAt: now, reason: 'Detach optical confirmation cartridge: ' + reason
	});

	return json({ success: true });
};
