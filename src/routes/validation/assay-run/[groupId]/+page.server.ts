import { error } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeGroup } from '$lib/server/db';
import { evaluateAssayRunGroup } from '$lib/server/assay-run/groups';
import { isGroupColorKey } from '$lib/server/optical-constants';
import type { PageServerLoad } from './$types';

/** One assay-run group, re-derived on open so it reflects the records as they are now. */
export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const g = (await CartridgeGroup.findById(params.groupId).lean()) as any;
	if (!g || g.purpose !== 'assay_run') throw error(404, 'Assay-run group not found');
	const evaluation = await evaluateAssayRunGroup(g._id);
	return JSON.parse(
		JSON.stringify({
			group: {
				id: g._id,
				name: g.name ?? '(unnamed)',
				color: isGroupColorKey(g.color) ? g.color : 'cyan',
				spuId: g.spuId ?? null,
				spuUdi: g.spuUdi ?? null,
				cartridgeIds: g.cartridgeIds ?? [],
				assayId: g.assayId ?? null,
				lot: g.lot ?? null,
				intendedConcentration: g.intendedConcentration ?? null,
				intendedConcentrationUnit: g.intendedConcentrationUnit ?? null,
				override: g.override ?? null,
				createdAt: g.createdAt ?? null,
				createdBy: g.createdBy ?? null,
				description: g.description ?? null
			},
			evaluation
		})
	);
};
