import { redirect } from '@sveltejs/kit';
import { cvFetch, cvThumbUrl } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { SampleResponse, InspectionResponse } from '$lib/types/cv';

export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');

	const filterResult = url.searchParams.get('result') || '';
	const filterPhase = url.searchParams.get('phase') || '';
	const filterCartridge = url.searchParams.get('cartridge') || '';
	const pageNum = parseInt(url.searchParams.get('page') || '1', 10);
	const pageSize = 20;

	let samples: SampleResponse[] = [];
	let allInspections: InspectionResponse[] = [];

	try {
		samples = await cvFetch<SampleResponse[]>('/api/v1/samples', {
			params: { limit: '200' }
		});
	} catch {
		return {
			inspections: [],
			filters: { result: filterResult, phase: filterPhase, cartridge: filterCartridge },
			pagination: { page: 1, totalPages: 1, total: 0 }
		};
	}

	for (const sample of samples) {
		try {
			const sampleInspections = await cvFetch<InspectionResponse[]>('/api/inspections', {
				params: { sample_id: sample.id }
			});
			allInspections.push(...sampleInspections);
		} catch { /* skip */ }
	}

	allInspections.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

	let filtered = allInspections;
	if (filterResult) {
		filtered = filtered.filter((i) => i.result === filterResult);
	}
	if (filterPhase) {
		filtered = filtered.filter((i) => i.phase === filterPhase);
	}
	if (filterCartridge) {
		filtered = filtered.filter((i) =>
			i.cartridge_record_id?.toLowerCase().includes(filterCartridge.toLowerCase())
		);
	}

	const total = filtered.length;
	const totalPages = Math.max(1, Math.ceil(total / pageSize));
	const start = (pageNum - 1) * pageSize;
	const paged = filtered.slice(start, start + pageSize);

	const sampleMap = new Map(samples.map((s) => [s.id, s.name]));

	const inspections = paged.map((insp) => ({
		...insp,
		thumbUrl: cvThumbUrl(insp.image_id),
		sampleName: sampleMap.get(insp.sample_id) || insp.sample_id
	}));

	return {
		inspections,
		filters: { result: filterResult, phase: filterPhase, cartridge: filterCartridge },
		pagination: { page: pageNum, totalPages, total }
	};
};
