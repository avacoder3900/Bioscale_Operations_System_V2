import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The validation section currently only has the Thermocouple step on master,
// so the section index sends operators straight to it. When more validation
// steps are ported, this can become a landing/dashboard instead.
export const load: PageServerLoad = async () => {
	redirect(302, '/spu/validation/thermocouple');
};
