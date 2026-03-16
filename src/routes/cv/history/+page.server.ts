import { getAllInspections, getSamples } from '$lib/server/cv-api';
import { cvImageUrl } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { InspectionResponse, SampleResponse } from '$lib/types/cv';

export const load: PageServerLoad = async ({ url }) => {
	const skip = parseInt(url.searchParams.get('skip') || '0', 10);
	const limit = parseInt(url.searchParams.get('limit') || '50', 10);

	let inspections: InspectionResponse[] = [];
	let samples: SampleResponse[] = [];
	let error: string | null = null;

	try {
		const [inspResult, samplesResult] = await Promise.allSettled([
			getAllInspections({ skip, limit }),
			getSamples(0, 100)
		]);

		if (inspResult.status === 'fulfilled') inspections = inspResult.value;
		if (samplesResult.status === 'fulfilled') samples = samplesResult.value;

		if (inspResult.status === 'rejected') {
			error = 'Unable to load inspections from CV API.';
		}
	} catch (e) {
		error = e instanceof Error ? e.message : 'Failed to load history';
	}

	return {
		inspections,
		samples,
		error,
		skip,
		limit,
		cvBaseUrl: cvImageUrl('').replace('/api/v1/images//file', '')
	};
};
