import { connectDB, ReagentLot, ReagentProtocolTemplate } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const slug = url.searchParams.get('template') ?? '';
	const lotIdsParam = url.searchParams.get('lots') ?? '';
	const lotIds = lotIdsParam.split(',').map((s) => s.trim()).filter(Boolean);

	const templates = await ReagentProtocolTemplate.find({ status: 'active' })
		.select('_id slug name version category')
		.sort({ category: 1, name: 1 })
		.lean();

	let template: any = null;
	let candidateLots: any[] = [];
	let selectedLots: any[] = [];

	if (slug) {
		template = await ReagentProtocolTemplate.findOne({ slug, status: 'active' })
			.sort({ version: -1 })
			.lean();
		if (template) {
			// Voided lots are excluded from the picker but can still be
			// loaded by id (selectedLots query below) if their _id was
			// passed in the URL — keeps share links resilient.
			candidateLots = await ReagentLot.find({ templateSlug: slug, status: { $ne: 'voided' } })
				.select('_id lotBarcode templateVersion operator status startedAt finalizedAt')
				.sort({ createdAt: -1 })
				.limit(100)
				.lean();
		}
	}

	if (lotIds.length) {
		selectedLots = await ReagentLot.find({ _id: { $in: lotIds } }).lean();
	}

	return {
		templates: JSON.parse(JSON.stringify(templates)),
		template: template ? JSON.parse(JSON.stringify(template)) : null,
		candidateLots: JSON.parse(JSON.stringify(candidateLots)),
		selectedLots: JSON.parse(JSON.stringify(selectedLots)),
		filters: { slug, lotIds }
	};
};
