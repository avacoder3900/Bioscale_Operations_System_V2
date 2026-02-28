import { redirect } from '@sveltejs/kit';
import { connectDB, LaserCutBatch, ManufacturingSettings } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [batches, settingsDoc] = await Promise.all([
		LaserCutBatch.find().sort({ createdAt: -1 }).limit(50).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	const general = (settingsDoc as any)?.general ?? {};

	return {
		sessions: batches.map((b: any) => ({
			id: b._id,
			status: b.failureCount > 0 ? 'partial' : 'completed',
			startedAt: b.createdAt,
			completedAt: b.updatedAt ?? null,
			operatorName: b.operatorId ?? null,
			sheetCount: b.inputSheetCount ?? 0,
			outputSheetCount: b.outputSheetCount ?? 0,
			failureCount: b.failureCount ?? 0,
			failureNotes: b.failureNotes ?? null,
			toolsUsed: b.toolsUsed ?? null,
			cuttingProgramLink: b.cuttingProgramLink ?? null
		})),
		defaults: {
			cartridgesPerSheet: general.cartridgesPerLaserCutSheet ?? null,
			sheetsPerBatch: general.sheetsPerLaserBatch ?? null,
			defaultTools: general.defaultLaserTools ?? null,
			defaultCuttingProgramLink: general.defaultCuttingProgramLink ?? null
		}
	};
};

export const actions: Actions = {
	start: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
		const general = settingsDoc?.general ?? {};

		await LaserCutBatch.create({
			inputSheetCount: Number(data.get('inputSheetCount') || 0),
			outputSheetCount: 0,
			failureCount: 0,
			toolsUsed: (data.get('toolsUsed') as string) || general.defaultLaserTools || undefined,
			cuttingProgramLink: (data.get('cuttingProgramLink') as string) || general.defaultCuttingProgramLink || undefined,
			operatorId: locals.user._id
		});

		return { success: true };
	},

	complete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const batchId = data.get('batchId') as string;

		await LaserCutBatch.findByIdAndUpdate(batchId, {
			$set: {
				outputSheetCount: Number(data.get('outputSheetCount') || 0),
				failureCount: Number(data.get('failureCount') || 0),
				failureNotes: (data.get('failureNotes') as string) || undefined
			}
		});

		return { success: true };
	},

	abort: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const batchId = data.get('batchId') as string;

		await LaserCutBatch.findByIdAndUpdate(batchId, {
			$set: {
				failureNotes: (data.get('failureNotes') as string) || 'Aborted',
				failureCount: Number(data.get('failureCount') || 0)
			}
		});

		return { success: true };
	}
};
