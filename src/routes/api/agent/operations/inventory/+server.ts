import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, PartDefinition, BomItem } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Inventory overview for agents.
 *
 * Optional query params:
 * - category=<name>  restrict to one classification (e.g. Critical), case-insensitive
 * - lowStockOnly=1   restrict to parts with count on hand <= 0
 *
 * The summary always includes lowStockParts and criticalLowStockParts so
 * "are any Critical parts running low?" is answerable from a single call.
 */
export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const category = url.searchParams.get('category')?.trim();
	const lowStockOnly = ['1', 'true'].includes(url.searchParams.get('lowStockOnly') ?? '');

	const [parts, bomItemCount] = await Promise.all([
		PartDefinition.find({ isActive: true })
			.select('_id partNumber name category inventoryCount unitOfMeasure')
			.sort({ partNumber: 1 }).lean(),
		BomItem.countDocuments()
	]);

	const categories = new Set<string>();
	const lowStockParts: any[] = [];
	const criticalLowStockParts: any[] = [];
	let mapped = (parts as any[]).map(p => {
		if (p.category) categories.add(p.category);
		const item = {
			id: p._id,
			partNumber: p.partNumber,
			name: p.name,
			category: p.category,
			inventoryCount: p.inventoryCount ?? 0,
			unitOfMeasure: p.unitOfMeasure
		};
		if (item.inventoryCount <= 0) {
			lowStockParts.push(item);
			if (/^critical$/i.test(item.category ?? '')) criticalLowStockParts.push(item);
		}
		return item;
	});

	if (category) mapped = mapped.filter(p => (p.category ?? '').toLowerCase() === category.toLowerCase());
	if (lowStockOnly) mapped = mapped.filter(p => p.inventoryCount <= 0);

	return json({
		success: true,
		data: {
			parts: mapped,
			summary: {
				totalParts: mapped.length,
				lowStockCount: lowStockParts.length,
				criticalLowStockCount: criticalLowStockParts.length,
				lowStockParts,
				criticalLowStockParts,
				categories: Array.from(categories).sort()
			},
			bomItemCount
		}
	});
};
