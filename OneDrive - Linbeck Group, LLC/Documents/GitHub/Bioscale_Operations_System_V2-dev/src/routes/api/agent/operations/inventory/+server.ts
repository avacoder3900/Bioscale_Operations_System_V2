import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, PartDefinition, BomItem } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [parts, bomItemCount] = await Promise.all([
		PartDefinition.find({ isActive: true })
			.select('_id partNumber name category inventoryCount unitOfMeasure')
			.sort({ partNumber: 1 }).lean(),
		BomItem.countDocuments()
	]);

	let lowStockCount = 0;
	const categories = new Set<string>();
	const mapped = (parts as any[]).map(p => {
		if ((p.inventoryCount ?? 0) <= 0) lowStockCount++;
		if (p.category) categories.add(p.category);
		return {
			id: p._id,
			partNumber: p.partNumber,
			name: p.name,
			category: p.category,
			inventoryCount: p.inventoryCount ?? 0,
			unitOfMeasure: p.unitOfMeasure
		};
	});

	return json({
		success: true,
		data: {
			parts: mapped,
			summary: {
				totalParts: mapped.length,
				lowStockCount,
				categories: Array.from(categories).sort()
			},
			bomItemCount
		}
	});
};
