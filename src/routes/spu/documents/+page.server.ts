import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// Navigation page — no data needed beyond layout
	return {};
};
