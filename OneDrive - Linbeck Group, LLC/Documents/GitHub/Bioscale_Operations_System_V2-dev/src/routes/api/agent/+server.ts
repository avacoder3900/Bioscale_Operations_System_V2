import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, SchemaMetadata } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const action = url.searchParams.get('action') || 'health';

	if (action === 'health') {
		return json({
			success: true,
			data: {
				status: 'healthy',
				timestamp: new Date().toISOString(),
				version: '2.0.0'
			}
		});
	}

	if (action === 'schema') {
		const metadata = await SchemaMetadata.find().lean();
		return json({
			success: true,
			data: {
				collections: metadata.map((m: any) => ({
					id: m._id,
					collectionName: m.collectionName || m.tableName,
					businessName: m.businessName,
					businessPurpose: m.businessPurpose,
					businessDomain: m.businessDomain,
					keyRelationships: m.keyRelationships,
					commonQueries: m.commonQueries,
					businessConcepts: m.businessConcepts
				}))
			}
		});
	}

	return json({ success: false, error: 'Unknown action' }, { status: 400 });
};
