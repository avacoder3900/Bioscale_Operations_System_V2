import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	return json({
		hasAgentApiKey: !!env.AGENT_API_KEY,
		keyLength: env.AGENT_API_KEY?.length ?? 0,
		keyPrefix: env.AGENT_API_KEY?.substring(0, 6) ?? 'EMPTY',
		hasMongoUri: !!env.MONGODB_URI,
		envKeys: Object.keys(env).filter(k => k.includes('AGENT') || k.includes('MONGO') || k.includes('API'))
	});
};
