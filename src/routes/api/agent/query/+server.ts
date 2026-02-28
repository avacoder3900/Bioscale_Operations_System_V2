import { json, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, AgentQuery, mongoose } from '$lib/server/db';
import type { RequestHandler } from './$types';

function requireApiKey(request: Request) {
	const key = request.headers.get('x-agent-api-key') || request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		throw error(401, 'Invalid or missing API key');
	}
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireApiKey(request);
	await connectDB();

	const queries = await AgentQuery.find({ isActive: true }).lean();
	return json({
		queries: queries.map((q: any) => ({
			id: q._id,
			name: q.name,
			description: q.description,
			category: q.category,
			parametersSchema: q.parametersSchema,
			resultFormat: q.resultFormat
		}))
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireApiKey(request);
	await connectDB();

	const body = await request.json();
	const { queryId, parameters } = body;

	if (!queryId) throw error(400, 'queryId required');

	const query = await AgentQuery.findById(queryId).lean() as any;
	if (!query || !query.isActive) throw error(404, 'Query not found or inactive');

	try {
		// Basic query executor: parse the sqlTemplate as a MongoDB query pattern
		// The template stores collection name and filter pattern
		const template = query.sqlTemplate || '';
		const collectionMatch = template.match(/FROM\s+(\w+)/i);
		if (!collectionMatch) throw error(400, 'Cannot parse query template');

		const collectionName = collectionMatch[1];
		const db = mongoose.connection.db;
		if (!db) throw error(500, 'Database not connected');

		const collection = db.collection(collectionName);

		// Build filter from parameters
		const filter: any = {};
		if (parameters) {
			for (const [key, value] of Object.entries(parameters)) {
				filter[key] = value;
			}
		}

		const maxRows = query.maxRows || 100;
		const results = await collection.find(filter).limit(maxRows).toArray();

		return json({
			queryId,
			queryName: query.name,
			rowCount: results.length,
			results,
			executedAt: new Date().toISOString()
		});
	} catch (e: any) {
		if (e.status) throw e;
		return json({ error: 'Query execution failed', message: e.message }, { status: 500 });
	}
};
