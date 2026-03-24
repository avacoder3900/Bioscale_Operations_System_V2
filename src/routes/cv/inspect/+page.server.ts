import { redirect } from '@sveltejs/kit';
import { cvFetch } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { SampleResponse, CameraInfo } from '$lib/types/cv';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	let samples: SampleResponse[] = [];
	let cameras: CameraInfo[] = [];

	try {
		samples = await cvFetch<SampleResponse[]>('/api/v1/samples', {
			params: { limit: '50' }
		});
	} catch { /* CV API may not be available */ }

	try {
		cameras = await cvFetch<CameraInfo[]>('/api/v1/cameras');
	} catch { /* cameras endpoint may not be available */ }

	return {
		samples: samples.map((s) => ({ id: s.id, name: s.name, project: s.project })),
		cameras
	};
};

export const config = { maxDuration: 60 };
