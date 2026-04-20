import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	cookies.delete('ot_operator_auth', { path: '/opentrons-clone' });
	throw redirect(303, '/opentrons-clone/operator-login');
};
