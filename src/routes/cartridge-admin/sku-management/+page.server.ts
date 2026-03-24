import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssayDefinition, BomItem, generateId, AuditLog } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const [assayDefs, bomItems] = await Promise.all([
		AssayDefinition.find().sort({ name: 1 }).lean(),
		BomItem.find({ isActive: true }).sort({ partNumber: 1 }).lean()
	]);

	type Reagent = {
		id: string;
		wellPosition: number | null;
		reagentName: string;
		unitCost: string | null;
		volumeMicroliters: number | null;
		unit: string | null;
		classification: string | null;
		isActive: boolean;
		sortOrder: number;
		subComponents: Array<{
			id: string;
			name: string;
			unitCost: string | null;
			unit: string | null;
			volumeMicroliters: number | null;
			classification: string | null;
			sortOrder: number;
		}>;
	};

	return {
		assayTypes: assayDefs.map((a: any) => ({
			id: a._id,
			assayId: a.assayId ?? a._id,
			name: a.name,
			skuCode: a.skuCode ?? null,
			description: a.description ?? null,
			duration: a.duration ?? null,
			shelfLifeDays: a.shelfLifeDays ?? null,
			bomCostOverride: a.bomCostOverride ?? null,
			useSingleCost: a.useSingleCost ?? false,
			isActive: a.isActive ?? true,
			lockedAt: a.lockedAt ?? null,
			reagents: (a.reagents ?? []).map((r: any): Reagent => ({
				id: r._id,
				wellPosition: r.wellPosition ?? null,
				reagentName: r.reagentName ?? '',
				unitCost: r.unitCost ?? null,
				volumeMicroliters: r.volumeMicroliters ?? null,
				unit: r.unit ?? null,
				classification: r.classification ?? null,
				isActive: r.isActive ?? true,
				sortOrder: r.sortOrder ?? 0,
				subComponents: (r.subComponents ?? []).map((sc: any) => ({
					id: sc._id,
					name: sc.name ?? '',
					unitCost: sc.unitCost ?? null,
					unit: sc.unit ?? null,
					volumeMicroliters: sc.volumeMicroliters ?? null,
					classification: sc.classification ?? null,
					sortOrder: sc.sortOrder ?? 0
				}))
			}))
		})),
		bomItems: bomItems.map((i: any): {
			id: string;
			partNumber: string;
			name: string;
			unitCost: string | null;
			quantityPerUnit: number;
			supplier: string | null;
			category: string | null;
		} => ({
			id: i._id,
			partNumber: i.partNumber ?? '',
			name: i.name ?? '',
			unitCost: i.unitCost ?? null,
			quantityPerUnit: Number(i.quantityPerUnit) || 1,
			supplier: i.supplier ?? null,
			category: i.category ?? null
		}))
	};
};

export const actions: Actions = {
	createAssayType: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const name = (data.get('name') as string)?.trim();
			const skuCode = (data.get('skuCode') as string)?.trim();
			const shelfLifeDays = Number(data.get('shelfLifeDays') || 90);

			if (!name) return fail(400, { error: 'Name is required' });
			if (!skuCode) return fail(400, { error: 'SKU code is required' });

			const existing = await AssayDefinition.findOne({ skuCode }).lean();
			if (existing) return fail(400, { error: 'SKU code already exists' });

			// Create with 6 default reagent wells (2-7)
			const reagents = [2, 3, 4, 5, 6, 7].map((well, i) => ({
				_id: generateId(),
				wellPosition: well,
				reagentName: `Reagent ${well}`,
				isActive: true,
				sortOrder: i,
				subComponents: []
			}));

			const newAssay = await AssayDefinition.create({
				_id: generateId(),
				name,
				skuCode,
				shelfLifeDays,
				isActive: true,
				reagents
			});
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: newAssay._id,
				action: 'INSERT',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});

			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to create assay type' });
		}
	},

	updateAssayType: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const id = data.get('id') as string;
			if (!id) return fail(400, { error: 'ID required' });

			const update: Record<string, any> = {};
			if (data.has('shelfLifeDays')) update.shelfLifeDays = Number(data.get('shelfLifeDays'));
			if (data.has('bomCostOverride')) {
				const v = (data.get('bomCostOverride') as string)?.trim();
				update.bomCostOverride = v || null;
				if (v) update.useSingleCost = true;
			}
			if (data.has('isActive')) update.isActive = data.get('isActive') === 'true';
			if (data.has('useSingleCost')) update.useSingleCost = data.get('useSingleCost') === 'true';

			await AssayDefinition.findByIdAndUpdate(id, { $set: update });
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: id,
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to update assay type' });
		}
	},

	updateReagentDefinition: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const definitionId = data.get('definitionId') as string;
			if (!definitionId) return fail(400, { error: 'Definition ID required' });

			const setFields: Record<string, any> = {};
			if (data.has('reagentName')) setFields['reagents.$.reagentName'] = (data.get('reagentName') as string)?.trim();
			if (data.has('unitCost')) {
				const v = (data.get('unitCost') as string)?.trim();
				setFields['reagents.$.unitCost'] = v || null;
			}
			if (data.has('volumeMicroliters')) {
				const v = data.get('volumeMicroliters');
				setFields['reagents.$.volumeMicroliters'] = v ? Number(v) : null;
			}
			if (data.has('unit')) setFields['reagents.$.unit'] = data.get('unit') as string;
			if (data.has('classification')) setFields['reagents.$.classification'] = data.get('classification') as string;
			if (data.has('hasBreakdown')) setFields['reagents.$.hasBreakdown'] = data.get('hasBreakdown') === 'true';

			await AssayDefinition.updateOne(
				{ 'reagents._id': definitionId },
				{ $set: setFields }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: definitionId,
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to update reagent definition' });
		}
	},

	toggleReagentActive: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const definitionId = data.get('definitionId') as string;
			const isActive = data.get('isActive') === 'true';
			if (!definitionId) return fail(400, { error: 'Definition ID required' });

			await AssayDefinition.updateOne(
				{ 'reagents._id': definitionId },
				{ $set: { 'reagents.$.isActive': isActive } }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: definitionId,
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to toggle reagent status' });
		}
	},

	createSubComponent: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const reagentDefinitionId = data.get('reagentDefinitionId') as string;
			const name = (data.get('name') as string)?.trim();
			if (!reagentDefinitionId) return fail(400, { error: 'Reagent definition ID required' });
			if (!name) return fail(400, { error: 'Name required' });

			const unitCost = (data.get('unitCost') as string)?.trim() || null;

			const newSc = {
				_id: generateId(),
				name,
				unitCost,
				unit: 'µL',
				volumeMicroliters: null,
				classification: 'raw',
				sortOrder: 0
			};

			await AssayDefinition.updateOne(
				{ 'reagents._id': reagentDefinitionId },
				{ $push: { 'reagents.$.subComponents': newSc } }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: reagentDefinitionId,
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to create sub-component' });
		}
	},

	updateSubComponent: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const subComponentId = data.get('subComponentId') as string;
			if (!subComponentId) return fail(400, { error: 'Sub-component ID required' });

			// Find the assay definition containing this sub-component
			const assay = await AssayDefinition.findOne({
				'reagents.subComponents._id': subComponentId
			}).lean() as any;
			if (!assay) return fail(404, { error: 'Sub-component not found' });

			// Build update using arrayFilters
			const setFields: Record<string, any> = {};
			if (data.has('name')) setFields['reagents.$[].subComponents.$[sc].name'] = (data.get('name') as string)?.trim();
			if (data.has('unitCost')) {
				const v = (data.get('unitCost') as string)?.trim();
				setFields['reagents.$[].subComponents.$[sc].unitCost'] = v || null;
			}
			if (data.has('volumeMicroliters')) {
				const v = data.get('volumeMicroliters');
				setFields['reagents.$[].subComponents.$[sc].volumeMicroliters'] = v ? Number(v) : null;
			}
			if (data.has('unit')) setFields['reagents.$[].subComponents.$[sc].unit'] = data.get('unit') as string;
			if (data.has('classification')) setFields['reagents.$[].subComponents.$[sc].classification'] = data.get('classification') as string;

			await AssayDefinition.updateOne(
				{ _id: assay._id, 'reagents.subComponents._id': subComponentId },
				{ $set: setFields },
				{ arrayFilters: [{ 'sc._id': subComponentId }] }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: subComponentId,
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to update sub-component' });
		}
	},

	deleteSubComponent: async ({ request, locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			const data = await request.formData();
			const subComponentId = data.get('subComponentId') as string;
			if (!subComponentId) return fail(400, { error: 'Sub-component ID required' });

			await AssayDefinition.updateOne(
				{ 'reagents.subComponents._id': subComponentId },
				{ $pull: { 'reagents.$[].subComponents': { _id: subComponentId } } }
			);
			await AuditLog.create({
				_id: generateId(),
				tableName: 'assay_definitions',
				recordId: subComponentId,
				action: 'DELETE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Failed to delete sub-component' });
		}
	},

	syncCartridgeBom: async ({ locals }) => {
		requirePermission(locals.user, 'cartridge:write');
		await connectDB();
		try {
			// Sync BOM items from PartDefinition (cartridge bomType) into BomItem collection
			const { PartDefinition } = await import('$lib/server/db');
			const parts = await PartDefinition.find({ bomType: 'cartridge', isActive: true }).lean() as any[];

			let created = 0, updated = 0, deleted = 0;

			// Upsert each part as a BomItem
			for (const part of parts) {
				const existing = await BomItem.findOne({ partNumber: part.partNumber, bomType: 'cartridge' }).lean() as any;
				if (existing) {
					await BomItem.findByIdAndUpdate(existing._id, {
						$set: {
							name: part.name ?? existing.name,
							category: part.category ?? existing.category,
							unitCost: part.unitCost ?? existing.unitCost,
							quantityPerUnit: part.quantityPerUnit ?? existing.quantityPerUnit ?? 1,
							supplier: part.supplier ?? existing.supplier,
							isActive: true
						}
					});
					updated++;
				} else {
					await BomItem.create({
						_id: generateId(),
						bomType: 'cartridge',
						partNumber: part.partNumber ?? '',
						name: part.name ?? '',
						category: part.category ?? null,
						unitCost: part.unitCost ?? null,
						quantityPerUnit: part.quantityPerUnit ?? 1,
						supplier: part.supplier ?? null,
						isActive: true
					});
					created++;
				}
			}

			await AuditLog.create({
				_id: generateId(),
				tableName: 'bom_items',
				recordId: 'sync',
				action: 'UPDATE',
				changedBy: locals.user?.username ?? locals.user?._id,
				changedAt: new Date()
			});
			return { success: true, syncResult: { created, updated, deleted } };
		} catch (err: any) {
			return fail(500, { error: err.message ?? 'Sync failed' });
		}
	}
};

export const config = { maxDuration: 60 };
