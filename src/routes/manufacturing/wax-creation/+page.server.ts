import { fail } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

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

	return { lotNumber };
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
				fridgeBarcode
			}
		});

		return { success: true, batchId };
	}
};
