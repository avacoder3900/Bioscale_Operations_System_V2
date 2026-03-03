import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	return json({
		success: true,
		data: {
			name: 'Bioscale Operations System V2',
			version: '2.0.0',
			database: 'mongodb'
		}
	});
};
