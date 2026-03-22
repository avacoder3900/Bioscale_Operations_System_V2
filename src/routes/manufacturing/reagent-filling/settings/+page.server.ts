import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, ManufacturingSettings, AssayDefinition, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:admin');

	try {
		await connectDB();

		const [settingsDoc, assayDefs] = await Promise.all([
			ManufacturingSettings.findById('default').lean(),
			AssayDefinition.find({}, { _id: 1, name: 1, skuCode: 1, isActive: 1, reagents: 1 }).sort({ name: 1 }).lean()
		]);

		const reagent = (settingsDoc as any)?.reagentFilling ?? {};
		const rejectionReasons = ((settingsDoc as any)?.rejectionReasonCodes ?? [])
			.filter((r: any) => !r.processType || r.processType === 'reagent')
			.map((r: any, i: number) => ({
				id: r._id ? String(r._id) : String(i),
				code: r.code ?? '',
				label: r.label ?? '',
				sortOrder: r.sortOrder ?? i
			}));

		return {
			settings: {
				minCoolingTimeMin: reagent.minCoolingTimeMin ?? 30,
				fillTimePerCartridgeMin: reagent.fillTimePerCartridgeMin ?? 0.5
			},
			assayTypes: (assayDefs as any[]).map((a) => ({
				id: String(a._id),
				name: a.name ?? '',
				skuCode: a.skuCode ?? '',
				isActive: a.isActive ?? true,
				reagents: (a.reagents ?? []).map((r: any) => ({
					id: String(r._id),
					reagentName: r.reagentName ?? '',
					wellPosition: r.wellPosition ?? null,
					volumeMicroliters: r.volumeMicroliters ?? null,
					isActive: r.isActive ?? true
				}))
			})),
			rejectionReasons
		};
	} catch (err) {
		console.error('[REAGENT-FILLING SETTINGS] Load error:', err instanceof Error ? err.message : err);
		return {
			settings: { minCoolingTimeMin: 30, fillTimePerCartridgeMin: 0.5 },
			assayTypes: [],
			rejectionReasons: []
		};
	}
};

export const actions: Actions = {
	/** Update numeric settings (form sends fillTime, coolingTime) */
	updateSettings: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const fillTime = data.get('fillTime') !== null ? Number(data.get('fillTime')) : null;
		const coolingTime = data.get('coolingTime') !== null ? Number(data.get('coolingTime')) : null;

		const update: Record<string, any> = {};
		if (fillTime !== null && !isNaN(fillTime)) update['reagentFilling.fillTimePerCartridgeMin'] = fillTime;
		if (coolingTime !== null && !isNaN(coolingTime)) update['reagentFilling.minCoolingTimeMin'] = coolingTime;

		if (Object.keys(update).length > 0) {
			update.updatedAt = new Date();
			await ManufacturingSettings.findByIdAndUpdate('default', { $set: update }, { upsert: true });
		}

		return { success: true };
	},

	/** Create a new assay type */
	createAssayType: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const name = (data.get('name') as string)?.trim();
		const skuCode = (data.get('skuCode') as string)?.trim();

		if (!name || !skuCode) return fail(400, { error: 'Name and SKU code are required' });

		const existing = await AssayDefinition.findOne({ skuCode }).lean();
		if (existing) return fail(400, { error: `SKU code '${skuCode}' already exists` });

		await AssayDefinition.create({
			name, skuCode, isActive: true, reagents: []
		});

		return { success: true };
	},

	/** Update assay type active status */
	updateAssayType: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const id = data.get('id') as string;
		const isActive = data.get('isActive') === 'true';

		await AssayDefinition.findByIdAndUpdate(id, { $set: { isActive } });
		return { success: true };
	},

	/** Toggle a reagent's active status */
	toggleReagentActive: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const definitionId = data.get('definitionId') as string;
		const isActive = data.get('isActive') === 'true';

		// definitionId is the reagent subdocument _id
		await AssayDefinition.findOneAndUpdate(
			{ 'reagents._id': definitionId },
			{ $set: { 'reagents.$.isActive': isActive } }
		);
		return { success: true };
	},

	/** Update a reagent's name */
	updateReagentName: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const definitionId = data.get('definitionId') as string;
		const newName = (data.get('newName') as string)?.trim();

		if (!newName) return fail(400, { error: 'Name is required' });

		await AssayDefinition.findOneAndUpdate(
			{ 'reagents._id': definitionId },
			{ $set: { 'reagents.$.reagentName': newName } }
		);
		return { success: true };
	},

	/** Create a rejection reason */
	createReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const code = (data.get('code') as string)?.trim();
		const label = (data.get('label') as string)?.trim();
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!code || !label) return fail(400, { error: 'Code and label are required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{
				$push: {
					rejectionReasonCodes: {
						_id: generateId(), code, label, processType: 'reagent', sortOrder
					}
				}
			},
			{ upsert: true }
		);
		return { success: true };
	},

	/** Update a rejection reason */
	updateReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const codeId = data.get('codeId') as string;
		const label = (data.get('label') as string)?.trim();
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!codeId || !label) return fail(400, { error: 'Code ID and label required' });

		await ManufacturingSettings.findOneAndUpdate(
			{ 'rejectionReasonCodes._id': codeId },
			{
				$set: {
					'rejectionReasonCodes.$.label': label,
					'rejectionReasonCodes.$.sortOrder': sortOrder
				}
			}
		);
		return { success: true };
	},

	/** Delete a rejection reason */
	deleteReason: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:admin');
		await connectDB();

		const data = await request.formData();
		const codeId = data.get('codeId') as string;

		if (!codeId) return fail(400, { error: 'Code ID required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{ $pull: { rejectionReasonCodes: { _id: codeId } } }
		);
		return { success: true };
	}
};
