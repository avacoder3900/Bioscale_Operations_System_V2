import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, SystemDependency } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const deps = await SystemDependency.find().lean();

	return json({
		success: true,
		data: {
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
		}
	});
};
