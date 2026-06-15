import { json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, WaxFillingRun, ManufacturingSettings } from '$lib/server/db';
import { releaseTrayForRun, DEFAULT_COOLING_REQUIRED_MIN } from '$lib/server/cooling';
import type { RequestHandler } from './$types';

const SYSTEM_OPERATOR = { _id: 'system-cron', username: 'system-cron' };

/**
 * Auto-timer backstop: free cooling trays whose batch has finished its required
 * cooling time. Moves each run's cartridges to loose storage and releases the
 * tray so the wax-filling flow never stalls on "all trays full".
 *
 * Trigger this from an external scheduler every few minutes:
 *   POST /api/cron/free-cooled-trays   (header: x-api-key: <AGENT_API_KEY>)
 */
export const POST: RequestHandler = async ({ request }) => {
	const key = request.headers.get('x-api-key')
		|| request.headers.get('x-agent-api-key')
		|| request.headers.get('authorization')?.replace('Bearer ', '');
	if (!env.AGENT_API_KEY || key !== env.AGENT_API_KEY) {
		return json({ error: 'Unauthorized' }, { status: 401 });
	}

	await connectDB();

	const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
	const requiredMin = settingsDoc?.waxFilling?.coolingRequiredMin ?? DEFAULT_COOLING_REQUIRED_MIN;
	const cutoff = new Date(Date.now() - requiredMin * 60_000);

	// Runs still holding a tray whose cooling window has elapsed.
	const runs = await WaxFillingRun.find({
		coolingTrayId: { $exists: true, $ne: null },
		coolingConfirmedTime: { $exists: true, $ne: null, $lte: cutoff }
	}).lean() as any[];

	const released: { runId: string; trayId: string | null; cartridgesMoved: number }[] = [];
	for (const run of runs) {
		const result = await releaseTrayForRun(run, {
			operator: SYSTEM_OPERATOR,
			changedBy: 'system-cron',
			reason: `Auto-released after ${requiredMin} min cooling window`
		});
		released.push({ runId: String(run._id), ...result });
	}

	return json({ success: true, requiredMin, releasedCount: released.length, released });
};
