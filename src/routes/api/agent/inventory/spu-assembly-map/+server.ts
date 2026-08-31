import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, PartDefinition } from '$lib/server/db';
import {
	getActiveSpuWorkInstruction,
	selectActiveWiVersion
} from '$lib/server/services/spu-work-instruction';
import { SPU_COMPONENT_PARTS } from '$lib/server/services/spu-component-parts';
import type { RequestHandler } from './$types';

function stripHtml(html: unknown): string | undefined {
	if (typeof html !== 'string') return undefined;
	return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500) || undefined;
}

/**
 * The SPU assembly parts knowledge base, two layers:
 *
 * - components: the curated component -> parts map from WIMF-SPU-01 (see
 *   spu-component-parts.ts), cross-checked live against part_definitions so
 *   each part carries inInventory / inventoryCount / isActive. This is how an
 *   agent resolves assembly-context language ("the screw for the upper metal
 *   bracket", "all magnets in the heating block") to concrete part numbers
 *   and per-SPU quantities.
 * - workInstruction: the step -> parts map of the active SPU work instruction
 *   in BIMS (may be sparse if only a skeleton WI has been uploaded).
 */
export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const partNumbers = [...new Set(SPU_COMPONENT_PARTS.flatMap((c) => c.parts.map((p) => p.partNumber)))];
	const defs = await PartDefinition.find({ partNumber: { $in: partNumbers } })
		.select('partNumber name inventoryCount isActive')
		.lean();
	const byNumber = new Map((defs as any[]).map((d) => [d.partNumber, d]));

	const components = SPU_COMPONENT_PARTS.map((c) => ({
		key: c.key,
		name: c.name,
		aliases: c.aliases,
		parts: c.parts.map((p) => {
			const def = byNumber.get(p.partNumber);
			return {
				...p,
				inInventory: !!def && def.isActive !== false,
				inventoryCount: def?.inventoryCount ?? null,
				inventoryName: def?.name ?? null
			};
		})
	}));

	let workInstruction: unknown = null;
	const wi = (await getActiveSpuWorkInstruction()) as any;
	if (wi) {
		const versions = wi.versions ?? [];
		const current = selectActiveWiVersion(wi)?.version ?? versions[versions.length - 1];
		if (current) {
			workInstruction = {
				workInstructionId: wi._id,
				title: wi.title,
				version: current.version,
				steps: (current.steps ?? []).map((s: any) => ({
					stepNumber: s.stepNumber,
					title: s.title,
					text: stripHtml(s.content),
					parts: (s.partRequirements ?? []).map((p: any) => ({
						partNumber: p.partNumber,
						partName: p.notes,
						quantityPerUnit: p.quantity
					}))
				}))
			};
		}
	}

	return json({
		success: true,
		data: {
			source: 'WIMF-SPU-01 VERSION 18',
			components,
			workInstruction
		}
	});
};
