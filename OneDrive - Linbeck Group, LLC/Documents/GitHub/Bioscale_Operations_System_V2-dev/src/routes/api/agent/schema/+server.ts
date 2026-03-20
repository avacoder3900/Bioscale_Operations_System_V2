import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, SchemaMetadata } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

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
};
