import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = async () => {
	// Auth and permissions are handled by the root layout
	return {};
};
