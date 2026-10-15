// ROUTE PRECEDENCE: `compare` is a STATIC sibling of `[groupId]` and wins only
// because SvelteKit prefers static segments — never rename it to anything a
// group id could equal (same hazard as optical-confirmation/groups/compare).
import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeGroup } from '$lib/server/db';
import { evaluateAssayRunGroup } from '$lib/server/assay-run/groups';
import type { PageServerLoad } from './$types';

/** Two assay-run groups side by side: ?a=<groupId>&b=<groupId>. */
export const load: PageServerLoad = async ({ url, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();
	const aId = url.searchParams.get('a')?.trim() ?? '';
	const bId = url.searchParams.get('b')?.trim() ?? '';
	if (!aId || !bId) return { sides: null, problem: 'Pick two groups on the Assay Run page (radio A and B) and press Compare.' };
	if (aId === bId) return { sides: null, problem: 'Group A and Group B are the same group.' };
	const docs = (await CartridgeGroup.find({ _id: { $in: [aId, bId] }, purpose: 'assay_run' }).select('_id name spuUdi lot assayId intendedConcentration cartridgeIds').lean()) as any[];
	const a = docs.find((g) => g._id === aId),
		b = docs.find((g) => g._id === bId);
	if (!a || !b) return { sides: null, problem: 'One of the groups could not be found (archived, or not an assay-run group).' };
	const [ea, eb] = await Promise.all([evaluateAssayRunGroup(aId), evaluateAssayRunGroup(bId)]);
	const side = (g: any, e: any) => ({ id: g._id, name: g.name, spuUdi: g.spuUdi ?? null, lot: g.lot ?? null, assayId: g.assayId ?? null, conc: g.intendedConcentration ?? null, n: g.cartridgeIds?.length ?? 0, evaluation: e });
	return JSON.parse(JSON.stringify({ sides: { a: side(a, ea), b: side(b, eb) }, problem: null }));
};
