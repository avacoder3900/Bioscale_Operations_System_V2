import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, KanbanTask, AuditLog } from '$lib/server/db';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

const MIN_AGE_MS = 24 * 60 * 60 * 1000;

function authenticate(request: Request): void {
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	if (request.method === 'GET') {
		const ua = request.headers.get('user-agent') ?? '';
		if (ua.startsWith('vercel-cron/')) return;
	}
	requireAgentApiKey(request);
}

async function runArchive(request: Request) {
	authenticate(request);
	await connectDB();

	const cutoff = new Date(Date.now() - MIN_AGE_MS);
	const result = await KanbanTask.updateMany(
		{ status: 'done', archived: false, statusChangedAt: { $lte: cutoff } },
		{ $set: { archived: true, archivedAt: new Date() } }
	);

	await AuditLog.create({
		tableName: 'kanban_tasks',
		recordId: 'cron-bulk',
		action: 'UPDATE',
		newData: { archived: true, count: result.modifiedCount, cutoff: cutoff.toISOString() },
		changedBy: 'system-cron'
	});

	console.log(`[KANBAN AUTO-ARCHIVE] archived=${result.modifiedCount} cutoff=${cutoff.toISOString()}`);
	return json({ success: true, archivedCount: result.modifiedCount });
}

export const GET: RequestHandler = ({ request }) => runArchive(request);
export const POST: RequestHandler = ({ request }) => runArchive(request);
