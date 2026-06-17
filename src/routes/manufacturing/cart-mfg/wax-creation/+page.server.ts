import { fail } from '@sveltejs/kit';
import { connectDB, AuditLog, WaxBatch, PartDefinition, generateId } from '$lib/server/db';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

const FULL_TUBE_VOLUME_UL = 12000; // 12 ml per 15 ml tube (filled per wax-creation instructions)

// Raw materials consumed by this work instruction (see docs/prds/WAX-CREATION-PARTS-LINK.md)
const WAX_PART_NUMBERS = ['PT-CT-108', 'PT-CT-109', 'PT-CT-110'];

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Generate sequential lot number: WAX-YYYY-NNNN
	const year = new Date().getFullYear();
	const prefix = `WAX-${year}-`;
	const lastBatch = await AuditLog.findOne({
		tableName: 'wax_creation_batch',
		'newData.lotNumber': { $regex: `^${prefix}` }
	}).sort({ changedAt: -1 }).lean();

	let seq = 1;
	if (lastBatch && (lastBatch as any).newData?.lotNumber) {
		const lastSeq = parseInt((lastBatch as any).newData.lotNumber.replace(prefix, ''), 10);
		if (!isNaN(lastSeq)) seq = lastSeq + 1;
	}
	const lotNumber = `${prefix}${String(seq).padStart(4, '0')}`;

	const waxParts = await PartDefinition.find({ partNumber: { $in: WAX_PART_NUMBERS } })
		.select('partNumber name unitCost unitOfMeasure supplier')
		.lean();

	return { lotNumber, waxParts: JSON.parse(JSON.stringify(waxParts)) };
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

		// Calculate total wax volume in this batch (12ml per full tube + partial)
		const initialVolumeUl = fullTubeCount * FULL_TUBE_VOLUME_UL + partialTubeMl * 1000;

		// Create WaxBatch record for runtime volume tracking (scanned during wax-filling)
		await WaxBatch.create({
			_id: batchId,
			lotNumber,
			lotBarcode,
			initialVolumeUl,
			remainingVolumeUl: initialVolumeUl,
			fullTubeCount,
			partialTubeMl,
			createdBy: { _id: locals.user!._id, username: locals.user!.username }
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'INSERT',
			tableName: 'wax_creation_batch',
			recordId: batchId,
			changedBy: locals.user!.username,
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
				fridgeBarcode,
				initialVolumeUl
			}
		});

		// Record raw-material consumption (PT-CT-108 nonadecane, PT-CT-109 micro wax, PT-CT-110 15ml tubes)
		const partDocs = await PartDefinition.find({ partNumber: { $in: WAX_PART_NUMBERS } })
			.select('partNumber')
			.lean();
		const partIdByNumber = new Map(partDocs.map((p: any) => [p.partNumber, String(p._id)]));
		const tubesUsed = fullTubeCount + (partialTubeMl > 0 ? 1 : 0);
		const consumptions = [
			{ partNumber: 'PT-CT-108', quantity: nanodecaneWeight / 100, notes: `Wax batch ${lotNumber} — ${nanodecaneWeight}g nonadecane (100g/bottle)` },
			{ partNumber: 'PT-CT-109', quantity: actualWaxWeight / 453.6, notes: `Wax batch ${lotNumber} — ${actualWaxWeight}g microcrystalline wax (453.6g/bag)` },
			{ partNumber: 'PT-CT-110', quantity: tubesUsed, notes: `Wax batch ${lotNumber} — ${fullTubeCount} full + ${partialTubeMl > 0 ? 1 : 0} partial tubes` }
		];
		for (const c of consumptions) {
			const partDefinitionId = partIdByNumber.get(c.partNumber);
			if (!partDefinitionId) continue;
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId,
				quantity: c.quantity,
				manufacturingRunId: batchId,
				operatorId: locals.user!._id,
				operatorUsername: locals.user!.username,
				notes: c.notes
			});
		}

		return { success: true, batchId };
	}
};
