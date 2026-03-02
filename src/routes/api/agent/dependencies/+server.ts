import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, SystemDependency } from '$lib/server/db';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const GET: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const deps = await SystemDependency.find().lean();

	return json({
		dependencies: deps.map((d: any) => ({
			id: d._id,
			systemName: d.systemName,
			ownerId: d.ownerId,
			backupOwnerId: d.backupOwnerId,
			systemType: d.systemType,
			dependencies: d.dependencies,
			dependents: d.dependents,
			changeSensitivity: d.changeSensitivity,
			impactScope: d.impactScope,
			lastUpdated: d.lastUpdated
		}))
	});
};
