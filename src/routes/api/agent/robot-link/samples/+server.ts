/**
 * Bulk connectivity-sample ingest (OT2-LOG-1 L2b).
 *
 * The lab iMac link monitor (scripts/imac-linkmon.py) posts one row per robot
 * per path per minute; the daemon's journal replay may post late rows too.
 * Authenticated by AGENT_API_KEY like the other agent routes.
 *
 *   POST /api/agent/robot-link/samples
 *   { samples: [{ robotId? , deviceId?, at: ISO, source: 'imac'|'daemon',
 *                 paths: [{ name: 'wifi'|'wired'|'tailnet', ip, lossPct, rttMs, healthMs, healthErr }] }] }
 *   ≤ 500 rows. Each row is validated on its own; bad rows are reported, not fatal.
 *
 *   → { inserted: number, rejected: [{ index, reason }] }
 */
import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { connectDB, RobotLinkSample, generateId } from '$lib/server/db';
import { MAX_SAMPLE_ROWS, validateSampleRow } from '$lib/server/services/robot-link/validate';
import { robotIdForDevice } from '$lib/server/services/robot-link/resolve-robot';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	requireAgentApiKey(request);

	let body: any;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const samples = body?.samples;
	if (!Array.isArray(samples)) throw error(400, 'samples must be an array');
	if (samples.length > MAX_SAMPLE_ROWS) throw error(400, `samples must have at most ${MAX_SAMPLE_ROWS} rows`);

	const now = new Date();
	const rejected: { index: number; reason: string }[] = [];
	const docs: { index: number; doc: Record<string, unknown> }[] = [];

	await connectDB();
	for (let index = 0; index < samples.length; index++) {
		const v = validateSampleRow(samples[index], now);
		if (!v.ok) {
			rejected.push({ index, reason: v.reason });
			continue;
		}
		const { row } = v;
		const robotId = row.robotId ?? (row.deviceId ? await robotIdForDevice(row.deviceId).catch(() => null) : null);
		docs.push({
			index,
			doc: {
				_id: generateId(),
				robotId,
				deviceId: row.deviceId ?? undefined,
				at: row.at,
				source: row.source,
				paths: row.paths
			}
		});
	}

	let inserted = 0;
	if (docs.length) {
		try {
			const res = await RobotLinkSample.insertMany(
				docs.map((d) => d.doc),
				{ ordered: false }
			);
			inserted = Array.isArray(res) ? res.length : docs.length;
		} catch (err: any) {
			// ordered:false keeps going past a bad row; report the ones Mongo refused.
			const writeErrors: Array<{ index: number; errmsg?: string }> = err?.writeErrors ?? [];
			inserted = typeof err?.insertedDocs?.length === 'number' ? err.insertedDocs.length : Math.max(0, docs.length - writeErrors.length);
			for (const we of writeErrors) {
				const d = docs[we.index];
				if (d) rejected.push({ index: d.index, reason: we.errmsg ?? 'write error' });
			}
			if (!writeErrors.length) throw error(500, `insert failed: ${err?.message ?? err}`);
		}
	}

	rejected.sort((a, b) => a.index - b.index);
	return json({ inserted, rejected });
};
