import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// Moved 2026-10-06: the SPU Assembly Work Instruction now lives under SPU.
export const load: PageServerLoad = async ({ url }) => {
	redirect(301, `/spu/assembly-wi${url.search}`);
};
