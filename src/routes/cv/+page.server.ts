import { getDashboardStats, getSamples, getCameras } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type { InspectionResponse, SampleResponse, CameraInfo, DashboardStats } from '$lib/types/cv';

export const load: PageServerLoad = async () => {
	let stats: DashboardStats | null = null;
	let samples: SampleResponse[] = [];
	let cameras: CameraInfo[] = [];
	let recentInspections: InspectionResponse[] = [];
	let error: string | null = null;

	try {
		const [statsResult, samplesResult, camerasResult] = await Promise.allSettled([
			getDashboardStats(),
			getSamples(0, 20),
			getCameras()
		]);

		if (statsResult.status === 'fulfilled') {
			stats = statsResult.value;
			recentInspections = stats.recent_inspections ?? [];
		}
		if (samplesResult.status === 'fulfilled') {
			samples = samplesResult.value;
		}
		if (camerasResult.status === 'fulfilled') {
			cameras = camerasResult.value;
		}

		if (statsResult.status === 'rejected' && samplesResult.status === 'rejected') {
			error = 'Unable to connect to CV API. Check that the CV service is running.';
		}
	} catch (e) {
		error = e instanceof Error ? e.message : 'Failed to load CV dashboard data';
	}

	return {
		stats,
		samples,
		cameras,
		recentInspections,
		error
	};
};
