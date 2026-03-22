import { redirect } from '@sveltejs/kit';
import { cvFetch, cvThumbUrl } from '$lib/server/cv-api';
import type { PageServerLoad } from './$types';
import type {
	SampleResponse,
	InspectionResponse,
	CameraInfo
} from '$lib/types/cv';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	let samples: SampleResponse[] = [];
	let inspections: InspectionResponse[] = [];
	let cameras: CameraInfo[] = [];
	let healthy = false;

	try {
		const health = await cvFetch<{ status: string }>('/health');
		healthy = health.status === 'ok' || health.status === 'healthy';
	} catch {
		// CV API not reachable
		return {
			healthy: false,
			samples: [],
			inspections: [],
			cameras: [],
			stats: { total: 0, passed: 0, failed: 0, pending: 0, passRate: 0 },
			cvApiUrl: ''
		};
	}

	try {
		samples = await cvFetch<SampleResponse[]>('/api/v1/samples', {
			params: { limit: '20' }
		});
	} catch { /* CV API may not have samples yet */ }

	try {
		cameras = await cvFetch<CameraInfo[]>('/api/v1/cameras');
	} catch { /* cameras endpoint may not be available */ }

	// Fetch inspections for each sample (up to first 5 samples to avoid overloading)
	const sampleSubset = samples.slice(0, 5);
	for (const sample of sampleSubset) {
		try {
			const sampleInspections = await cvFetch<InspectionResponse[]>('/api/inspections', {
				params: { sample_id: sample.id }
			});
			inspections.push(...sampleInspections);
		} catch { /* skip failed fetches */ }
	}

	// Sort inspections by created_at descending
	inspections.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

	// Compute stats
	const total = inspections.length;
	const passed = inspections.filter((i) => i.result === 'pass').length;
	const failed = inspections.filter((i) => i.result === 'fail').length;
	const pending = inspections.filter((i) => i.status === 'pending' || i.status === 'processing').length;
	const passRate = total > 0 ? Math.round((passed / (passed + failed || 1)) * 100) : 0;

	// Add thumb URLs to inspections for display
	const inspectionsWithThumbs = inspections.slice(0, 20).map((insp) => ({
		...insp,
		thumbUrl: cvThumbUrl(insp.image_id)
	}));

	return {
		healthy,
		samples: samples.map((s) => ({ id: s.id, name: s.name, project: s.project })),
		inspections: inspectionsWithThumbs,
		cameras,
		stats: { total, passed, failed, pending, passRate }
	};
};

export const config = { maxDuration: 60 };
