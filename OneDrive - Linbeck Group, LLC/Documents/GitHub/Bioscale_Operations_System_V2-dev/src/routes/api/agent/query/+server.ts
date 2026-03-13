import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, AgentQuery, AuditLog, generateId, mongoose } from '$lib/server/db';
import type { RequestHandler } from './$types';

const ALLOWED_COLLECTIONS = new Set([
	'kanban_tasks', 'kanban_projects', 'customers', 'equipment', 'equipment_locations',
	'documents', 'work_instructions', 'part_definitions', 'bom_items', 'spus',
	'production_runs', 'lot_records', 'shipping_lots', 'shipping_packages',
	'test_results', 'audit_log', 'cartridge_records', 'batches',
	'agent_messages', 'approval_requests', 'schema_metadata'
]);

function sanitizeFilterValue(value: unknown): unknown {
	if (value === null || value === undefined) return value;
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
	if (value instanceof Date) return value;
	return undefined;
}

function sanitizeFilter(parameters: Record<string, unknown>): Record<string, unknown> {
	const filter: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(parameters)) {
		if (key.startsWith('$') || key.includes('.')) continue;
		const sanitized = sanitizeFilterValue(value);
		if (sanitized !== undefined) {
			filter[key] = sanitized;
		}
	}
	return filter;
}

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const queries = await AgentQuery.find({ isActive: true }).lean();
	return json({
		success: true,
		data: {
			queries: queries.map((q: any) => ({
				id: q._id,
				name: q.name,
				description: q.description,
				category: q.category,
				collectionName: q.collectionName,
				parametersSchema: q.parametersSchema,
				resultFormat: q.resultFormat
			}))
		}
	});
};

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const body = await request.json();
	const { queryId, parameters } = body;

	if (!queryId) {
		return json({ success: false, error: 'queryId required' }, { status: 400 });
	}

	const query = await AgentQuery.findById(queryId).lean() as any;
	if (!query || !query.isActive) throw error(404, 'Query not found or inactive');

	try {
		// Determine collection name: prefer collectionName, fall back to sqlTemplate parsing
		let collectionName = query.collectionName;
		if (!collectionName && query.sqlTemplate) {
			const match = query.sqlTemplate.match(/FROM\s+(\w+)/i);
			collectionName = match?.[1];
		}
		if (!collectionName) {
			return json({ success: false, error: 'Query has no collection target' }, { status: 400 });
		}

		if (!ALLOWED_COLLECTIONS.has(collectionName)) {
			return json({ success: false, error: `Collection '${collectionName}' is not queryable` }, { status: 400 });
		}

		const db = mongoose.connection.db;
		if (!db) throw error(500, 'Database not connected');

		const collection = db.collection(collectionName);

		// Build filter: start with base mongoQuery, merge sanitized user parameters
		const baseFilter = query.mongoQuery && typeof query.mongoQuery === 'object' ? { ...query.mongoQuery } : {};
		const userFilter = parameters ? sanitizeFilter(parameters) : {};
		const filter = { ...baseFilter, ...userFilter };

		const maxRows = query.maxRows || 100;
		const results = await collection.find(filter).limit(maxRows).toArray();

		await AuditLog.create({
			_id: generateId(),
			tableName: 'agent_queries',
			recordId: queryId,
			action: 'UPDATE',
			newData: { collectionName, filterKeys: Object.keys(filter), rowCount: results.length },
			changedAt: new Date(),
			changedBy: 'agent-api',
			reason: 'Query executed'
		});

		return json({
			success: true,
			data: {
				queryId,
				queryName: query.name,
				rowCount: results.length,
				results: JSON.parse(JSON.stringify(results)),
				executedAt: new Date().toISOString()
			}
		});
	} catch (e: any) {
		if (e.status) throw e;
		return json({ success: false, error: 'Query execution failed', message: e.message }, { status: 500 });
	}
};
