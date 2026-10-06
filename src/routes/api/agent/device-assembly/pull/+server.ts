import { json, error } from '@sveltejs/kit';
import { connectDB } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { resolveActor, ActorError } from '$lib/server/machine-actor';
import { sectionLabel } from '$lib/server/services/device-assembly-wi';
import { pullMaterialsForStep } from '$lib/server/services/device-assembly-wi-pulls';
import { RefError, requireWI, resolveStep, resolveMaterial, stockIndex, materialView } from '$lib/server/services/device-assembly-wi-agent';
import type { RequestHandler } from './$types';

/**
 * POST /api/agent/device-assembly/pull — deduct a step's materials from inventory.
 * Body: { actor, confirmed, section, step, items?: [{ material, quantity? }], unitsBuilt?, deviceSerial?, notes? }
 * Without `items`, every catalog-linked part on the step is pulled at quantityPerDevice × unitsBuilt.
 * With confirmed !== true the response is a preview (no inventory change).
 */
export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();
	const body: any = await request.json().catch(() => ({}));
	let actor;
	try {
		const r = await resolveActor(body.actor);
		actor = { _id: r.userId, username: r.username };
	} catch (e: any) {
		if (e instanceof ActorError) throw error(400, e.message);
		throw e;
	}
	try {
		const wi = await requireWI();
		const { section, step } = resolveStep(wi, body.section, body.step ?? body.stepId);
		const unitsBuilt = body.unitsBuilt && Number(body.unitsBuilt) > 0 ? Number(body.unitsBuilt) : 1;
		const stock = await stockIndex(wi);

		let planned: { material: any; quantity: number }[];
		if (Array.isArray(body.items) && body.items.length) {
			planned = body.items.map((it: any) => {
				const material = resolveMaterial(step, String(it.material ?? it.materialId ?? it.partNumber ?? ''));
				const quantity = it.quantity != null ? Number(it.quantity) : (material.quantity ?? 1) * unitsBuilt;
				return { material, quantity };
			});
		} else {
			planned = step.materials.filter((m: any) => m.kind === 'part' && m.deductFromInventory !== false).map((m: any) => ({ material: m, quantity: (m.quantity ?? 1) * unitsBuilt }));
		}
		if (!planned.length) throw error(400, `Step ${step.stepNumber} in ${sectionLabel(section)} has no inventory parts to pull`);

		const preview = planned.map((p) => ({ ...materialView(p.material, stock), deduct: p.quantity, after: p.material.partDefinitionId && stock[p.material.partDefinitionId] ? stock[p.material.partDefinitionId].inventoryCount - p.quantity : null }));
		const blocked = preview.filter((p) => !p.linkedToCatalog);
		if (body.confirmed !== true) {
			return json({ success: true, applied: false, preview: { section: sectionLabel(section), stepNumber: step.stepNumber, title: step.title, unitsBuilt, items: preview, blocked: blocked.map((b) => `${b.name}${b.partNumber ? ` (${b.partNumber})` : ''} is not linked to the parts catalog`), next: 'Show this list to the user; call again with confirmed: true to deduct.' } });
		}
		if (blocked.length) throw error(400, `Cannot pull: ${blocked.map((b) => `${b.name}${b.partNumber ? ` (${b.partNumber})` : ''} is not linked to the parts catalog`).join('; ')}. Fix the part number with device_wi_update_material first, or pass items without it.`);

		const r = await pullMaterialsForStep({ sectionNumber: section.number, stepId: step._id, items: planned.map((p) => ({ materialId: p.material._id, quantity: p.quantity })), unitsBuilt, deviceSerial: body.deviceSerial ?? null, notes: body.notes ?? null }, actor);
		return json({ success: true, applied: true, data: { section: sectionLabel(section), stepNumber: r.stepNumber, unitsBuilt, deviceSerial: body.deviceSerial ?? null, performedBy: actor.username, items: r.results } }, { status: 201 });
	} catch (e: any) {
		if (e instanceof RefError) throw error(404, e.message);
		if (e?.status) throw e;
		throw error(400, e?.message ?? String(e));
	}
};
