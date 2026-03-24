import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	return json({
		success: true,
		data: {
			status: 'healthy',
			timestamp: new Date().toISOString(),
			version: '2.0.0'
		}
	});
};
