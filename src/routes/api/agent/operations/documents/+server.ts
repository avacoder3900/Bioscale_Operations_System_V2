import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, Document, WorkInstruction } from '$lib/server/db';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);
	await connectDB();

	const [documents, workInstructions] = await Promise.all([
		Document.find()
			.select('_id documentNumber title category status currentRevision createdAt')
			.sort({ createdAt: -1 }).lean(),
		WorkInstruction.find()
			.select('_id title status currentVersion createdAt')
			.sort({ createdAt: -1 }).lean()
	]);

	const byStatus: Record<string, number> = {};
	for (const doc of documents as any[]) {
		const s = doc.status || 'unknown';
		byStatus[s] = (byStatus[s] || 0) + 1;
	}

	return json({
		success: true,
		data: {
			documents: (documents as any[]).map(d => ({
				id: d._id,
				documentNumber: d.documentNumber,
				title: d.title,
				category: d.category,
				status: d.status,
				currentRevision: d.currentRevision
			})),
			workInstructions: (workInstructions as any[]).map(w => ({
				id: w._id,
				title: w.title,
				isActive: w.status === 'active',
				currentVersion: w.currentVersion
			})),
			summary: {
				totalDocs: (documents as any[]).length,
				byStatus,
				totalWorkInstructions: (workInstructions as any[]).length
			}
		}
	});
};
