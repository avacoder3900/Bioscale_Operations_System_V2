import { requirePermission } from '$lib/server/permissions';
import { connectDB, AssayDefinition, BomItem } from '$lib/server/db';
import type { PageServerLoad } from './$types';

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
