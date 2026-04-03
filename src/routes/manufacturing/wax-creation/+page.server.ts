import { fail } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db/connection';
import { AuditLog, PartDefinition, InventoryTransaction } from '$lib/server/db/models';
import { generateId } from '$lib/server/db/utils';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const year = new Date().getFullYear();
	const prefix = `WAX-${year}-`;
	const lastBatch = await AuditLog.findOne({
		tableName: 'wax_creation_batch',
		'newData.lotNumber': { $regex: `^${prefix}` }
	}).sort({ changedAt: -1 }).lean();

	let seq = 1;
	if (lastBatch && lastBatch.newData?.lotNumber) {
		const lastSeq = parseInt(lastBatch.newData.lotNumber.replace(prefix, ''), 10);
		if (!isNaN(lastSeq)) seq = lastSeq + 1;
	}
	const lotNumber = `${prefix}${String(seq).padStart(4, '0')}`;

	const waxParts = await PartDefinition.find({
		partNumber: { $in: ['PT-CT-108', 'PT-CT-109', 'PT-CT-110'] }
	}).select('partNumber name unitCost unitOfMeasure supplier').lean();

	return {
		lotNumber,
		waxParts: JSON.parse(JSON.stringify(waxParts))
	};
};

export const actions: Actions = {
	save: async ({ request, locals }) => {
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const nanodecaneWeight = parseFloat(data.get('nanodecaneWeight')?.toString() || '0');
		const actualWaxWeight = parseFloat(data.get('actualWaxWeight')?.toString() || '0');
		const fullTubeCount = parseInt(data.get('fullTubeCount')?.toString() || '0', 10);
		const partialTubeMl = parseFloat(data.get('partialTubeMl')?.toString() || '0');
		const fridgeBarcode = data.get('fridgeBarcode')?.toString() || '';
		const lotBarcode = data.get('lotBarcode')?.toString() || '';
		const lotNumber = data.get('lotNumber')?.toString() || '';
		const targetWaxWeight = parseFloat(data.get('targetWaxWeight')?.toString() || '0');
		const expectedTubes = parseInt(data.get('expectedTubes')?.toString() || '0', 10);

		if (!nanodecaneWeight || !actualWaxWeight || !fullTubeCount || !lotNumber || !fridgeBarcode || !lotBarcode) {
			return fail(400, { error: 'All fields are required' });
		}

		const batchId = generateId();
		await AuditLog.create({
			_id: generateId(),
			action: 'INSERT',
			tableName: 'wax_creation_batch',
			recordId: batchId,
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: {
				lotNumber,
				lotBarcode,
				nanodecaneWeight,
				targetWaxWeight,
				actualWaxWeight,
				expectedTubes,
				fullTubeCount,
				partialTubeMl,
				fridgeBarcode
			}
		});

		// Record inventory consumption for raw materials
		const waxParts = await PartDefinition.find({
			partNumber: { $in: ['PT-CT-108', 'PT-CT-109', 'PT-CT-110'] }
		}).lean();

		const partMap = Object.fromEntries(waxParts.map(p => [p.partNumber, p]));
		const now = new Date();
		const consumptions = [
			{ partNumber: 'PT-CT-108', quantity: -(nanodecaneWeight / 100) },
			{ partNumber: 'PT-CT-109', quantity: -(actualWaxWeight / 453.6) },
			{ partNumber: 'PT-CT-110', quantity: -(fullTubeCount + (partialTubeMl > 0 ? 1 : 0)) }
		];

		for (const c of consumptions) {
			const part = partMap[c.partNumber];
			if (!part) continue;
			await InventoryTransaction.create({
				_id: generateId(),
				partDefinitionId: part._id,
				transactionType: 'consumption',
				quantity: c.quantity,
				previousQuantity: part.inventoryCount,
				newQuantity: (part.inventoryCount || 0) + c.quantity,
				reason: `Wax creation batch ${lotNumber}`,
				manufacturingStep: 'wax_filling',
				manufacturingRunId: batchId,
				performedBy: locals.user.username,
				performedAt: now,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username
			});
		}

		return { success: true, batchId };
	}
};
