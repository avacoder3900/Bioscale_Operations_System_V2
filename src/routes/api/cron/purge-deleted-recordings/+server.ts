import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, AuditLog } from '$lib/server/db';
import { RobotArmDeletedRecording } from '$lib/server/db/models';
import { deleteFile } from '$lib/server/r2';
import { requireAgentApiKey } from '$lib/server/api-auth';
import type { RequestHandler } from './$types';

// Daily purge of the robot-arm recording trash. Removes the R2 recovery copy
// and the trash row for every entry past expiresAt (30 days after deletion).
// This is the ONLY path that permanently removes a trashed recording. Never
// touches the Pi. A failed R2 delete keeps its row, so the next run retries it.

function authenticate(request: Request): void {
	// CRON_SECRET Bearer (Vercel sends it automatically when the env var is set)
	// or the agent API key. No user-agent fallback — that header is forgeable.
	const auth = request.headers.get('authorization')?.replace('Bearer ', '');
	if (env.CRON_SECRET && auth === env.CRON_SECRET) return;
	requireAgentApiKey(request);
}

async function runPurge(request: Request) {
	authenticate(request);
	await connectDB();

	const now = new Date();
	const expired = (await RobotArmDeletedRecording.find({ expiresAt: { $lte: now } })
		.select('_id name r2Key')
		.limit(500)
		.lean()) as { _id: string; name: string; r2Key: string }[];

	const purged: string[] = [];
	const failed: { id: string; error: string }[] = [];
	for (const row of expired) {
		try {
			await deleteFile(row.r2Key);
			await RobotArmDeletedRecording.deleteOne({ _id: row._id });
			purged.push(row._id);
		} catch (err) {
			failed.push({ id: row._id, error: (err as Error).message });
		}
	}

	if (purged.length || failed.length) {
		await AuditLog.create({
			tableName: 'robot_arm_deleted_recordings',
			recordId: 'cron-bulk',
			action: 'DELETE',
			newData: { purged: purged.length, failed: failed.length, cutoff: now.toISOString() },
			changedBy: 'system-cron'
		});
	}

	console.log(`[ARM RECORDING PURGE] purged=${purged.length} failed=${failed.length}`);
	return json({ success: failed.length === 0, purgedCount: purged.length, failed });
}

export const GET: RequestHandler = ({ request }) => runPurge(request);
export const POST: RequestHandler = ({ request }) => runPurge(request);
