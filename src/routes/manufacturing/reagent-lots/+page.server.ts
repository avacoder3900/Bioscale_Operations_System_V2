import { connectDB, ReagentLot, ReagentProtocolTemplate } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const statusFilter = url.searchParams.get('status') ?? 'all';
	const templateSlugFilter = url.searchParams.get('template') ?? 'all';

	const query: Record<string, unknown> = {};
	// Hide deleted by default — surface them only when explicitly filtered.
	if (statusFilter === 'all') query.status = { $ne: 'deleted' };
	else query.status = statusFilter;
	if (templateSlugFilter !== 'all') query.templateSlug = templateSlugFilter;

	const [lots, templates] = await Promise.all([
		ReagentLot.find(query)
			.select(
				'_id lotBarcode templateName templateSlug templateVersion operator status startedAt finalizedAt voidedAt flags finalOutputs createdAt'
			)
			.sort({ createdAt: -1 })
			.limit(200)
			.lean(),
		ReagentProtocolTemplate.find({ status: 'active' })
			.select('_id slug name version category')
			.sort({ category: 1, name: 1 })
			.lean()
	]);

	return {
		lots: JSON.parse(JSON.stringify(lots)),
		templates: JSON.parse(JSON.stringify(templates)),
		filters: { status: statusFilter, template: templateSlugFilter }
	};
};
