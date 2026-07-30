import { json, error } from '@sveltejs/kit';
import { connectDB, PartDefinition } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Part resolution for agent-driven inventory work.
 *
 * Lookup modes (first provided wins):
 * - barcode: exact match on the part's scannable barcode, falling back to partNumber
 * - partNumber: exact case-insensitive match
 * - q: free-text search — every whitespace token must match name, description,
 *   partNumber, or category (so "screw upper bracket" finds "Upper Metal Bracket Screw")
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const barcode = url.searchParams.get('barcode')?.trim();
	const partNumber = url.searchParams.get('partNumber')?.trim();
	const q = url.searchParams.get('q')?.trim();
	const bomType = url.searchParams.get('bomType')?.trim();
	const limit = Math.min(Number(url.searchParams.get('limit')) || 20, 50);

	if (!barcode && !partNumber && !q) throw error(400, 'Provide one of: barcode, partNumber, or q');

	const baseFilter: Record<string, unknown> = { isActive: { $ne: false } };
	if (bomType) baseFilter.bomType = bomType;

	let parts: any[] = [];
	if (barcode) {
		parts = await PartDefinition.find({ ...baseFilter, barcode }).lean();
		if (parts.length === 0) {
			parts = await PartDefinition.find({
				...baseFilter,
				partNumber: new RegExp(`^${escapeRegex(barcode)}$`, 'i')
			}).lean();
		}
	} else if (partNumber) {
		parts = await PartDefinition.find({
			...baseFilter,
			partNumber: new RegExp(`^${escapeRegex(partNumber)}$`, 'i')
		}).lean();
	} else if (q) {
		const tokens = q.split(/\s+/).filter(Boolean).map(escapeRegex);
		const filter = {
			...baseFilter,
			$and: tokens.map((t) => ({
				$or: [
					{ name: new RegExp(t, 'i') },
					{ description: new RegExp(t, 'i') },
					{ partNumber: new RegExp(t, 'i') },
					{ category: new RegExp(t, 'i') }
				]
			}))
		};
		parts = await PartDefinition.find(filter).sort({ partNumber: 1 }).limit(limit).lean();
	}

	return json({
		success: true,
		data: {
			count: parts.length,
			parts: parts.slice(0, limit).map((p) => ({
				id: p._id,
				partNumber: p.partNumber,
				name: p.name,
				description: p.description,
				category: p.category,
				bomType: p.bomType,
				barcode: p.barcode,
				inventoryCount: p.inventoryCount ?? 0,
				unitOfMeasure: p.unitOfMeasure,
				quantityPerUnit: p.quantityPerUnit
			}))
		}
	});
};
