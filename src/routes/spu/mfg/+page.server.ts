import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The SPU inventory that used to live here moved to /spu (SPU-INV-02).
// Entering SPU Manufacturing now starts on the SPU Assembly tab.
export const load: PageServerLoad = async () => {
	throw redirect(302, '/assembly');
};
