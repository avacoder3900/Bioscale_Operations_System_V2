import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, SchemaMetadata } from '$lib/server/db';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-api-key') || request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireApiKey(request);
	await connectDB();

	const action = url.searchParams.get('action') || 'health';

	if (action === 'health') {
		return json({
			status: 'healthy',
			timestamp: new Date().toISOString(),
			version: '2.0.0'
		});
	}

	if (action === 'schema') {
		const metadata = await SchemaMetadata.find().lean();
		return json({
			collections: metadata.map((m: any) => ({
				id: m._id,
				tableName: m.tableName,
				businessName: m.businessName,
				businessPurpose: m.businessPurpose,
				businessDomain: m.businessDomain,
				keyRelationships: m.keyRelationships,
				commonQueries: m.commonQueries,
				businessConcepts: m.businessConcepts
			}))
		});
	}

	return json({ error: 'Unknown action' }, { status: 400 });
};
