import { error, redirect } from '@sveltejs/kit';
import { connectDB, AssayDefinition } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const assay = await AssayDefinition.findById(params.assayId).lean() as any;
	if (!assay) throw error(404, 'Assay not found');

	return {
		assay: {
			id: assay._id,
			name: assay.name,
			skuCode: assay.skuCode ?? null,
			version: assay.versionHistory?.length ?? 0,
			status: assay.lockedAt ? 'locked' : (assay.isActive ? 'active' : 'inactive'),
			description: assay.description ?? null,
			duration: assay.duration ?? null,
			shelfLifeDays: assay.shelfLifeDays ?? null,
			bcode: assay.bcode ?? null,
			bcodeLength: assay.bcodeLength ?? null,
			checksum: assay.checksum ?? null,
			bomCostOverride: assay.bomCostOverride ?? null,
			useSingleCost: assay.useSingleCost ?? false,
			lockedAt: assay.lockedAt ?? null,
			lockedBy: assay.lockedBy ?? null,
			reagents: (assay.reagents ?? []).map((r: any) => ({
				id: r._id,
				wellPosition: r.wellPosition ?? null,
				reagentName: r.reagentName ?? null,
				unitCost: r.unitCost ?? null,
				volumeMicroliters: r.volumeMicroliters ?? null,
				unit: r.unit ?? null,
				classification: r.classification ?? null,
				hasBreakdown: r.hasBreakdown ?? false,
				sortOrder: r.sortOrder ?? null,
				isActive: r.isActive ?? true,
				subComponents: (r.subComponents ?? []).map((s: any) => ({
					id: s._id,
					name: s.name ?? null,
					unitCost: s.unitCost ?? null,
					unit: s.unit ?? null,
					volumeMicroliters: s.volumeMicroliters ?? null,
					classification: s.classification ?? null,
					sortOrder: s.sortOrder ?? null
				}))
			})),
			configuration: assay.metadata ?? {},
			createdAt: assay.createdAt,
			updatedAt: assay.updatedAt
		},
		versions: (assay.versionHistory ?? []).map((v: any) => ({
			version: v.version,
			createdAt: v.changedAt ?? null,
			changes: v.changeNotes ?? null
		}))
	};
};

export const actions: Actions = {
	lock: async ({ params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		await AssayDefinition.findOneAndUpdate(
			{ _id: params.assayId, lockedAt: { $exists: false } },
			{
				$set: {
					lockedAt: new Date(),
					lockedBy: { _id: locals.user._id, username: locals.user.username }
				}
			}
		);
		return { success: true };
	},

	unlock: async ({ params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		await AssayDefinition.findByIdAndUpdate(params.assayId, {
			$unset: { lockedAt: 1, lockedBy: 1 }
		});
		return { success: true };
	},

	toggleActive: async ({ params, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const assay = await AssayDefinition.findById(params.assayId).lean() as any;
		if (!assay) throw error(404, 'Assay not found');

		await AssayDefinition.findByIdAndUpdate(params.assayId, {
			$set: { isActive: !assay.isActive }
		});
		return { success: true };
	}
};
