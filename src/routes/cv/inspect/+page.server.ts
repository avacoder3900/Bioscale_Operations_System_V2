import { getSamples, getCameras } from '$lib/server/cv-api';
import { cvImageUrl } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { SampleResponse, CameraInfo } from '$lib/types/cv';

export const load: PageServerLoad = async () => {
	let samples: SampleResponse[] = [];
	let cameras: CameraInfo[] = [];
	let error: string | null = null;

	try {
		const [samplesResult, camerasResult] = await Promise.allSettled([
			getSamples(0, 50),
			getCameras()
		]);

		if (samplesResult.status === 'fulfilled') samples = samplesResult.value;
		if (camerasResult.status === 'fulfilled') cameras = camerasResult.value;

		if (samplesResult.status === 'rejected' && camerasResult.status === 'rejected') {
			error = 'Unable to connect to CV API.';
		}
	} catch (e) {
		error = e instanceof Error ? e.message : 'Failed to load capture page data';
	}

	return { samples, cameras, error, cvBaseUrl: cvImageUrl('').replace('/api/v1/images//file', '') };
};
