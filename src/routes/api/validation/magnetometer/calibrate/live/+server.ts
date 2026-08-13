import { json } from '@sveltejs/kit';
import { connectDB, Spu } from '$lib/server/db';
import { getVariable } from '$lib/server/particle';
import type { RequestHandler } from './$types';

/**
 * Live stage telemetry for the calibration tool (firmware v90+).
 *
 * The `stage_control` cloud function blocks for the whole move, so its return
 * value only tells you where the stage ended up. The firmware also publishes
 * two cloud variables that the Particle system thread keeps serving during the
 * move, which is what makes real-time tracking possible:
 *   - stage_pos    — current position in microns from the limit-switch zero
 *   - stage_moving — 1 while a move is in flight, 0 at rest
 *
 * GET /api/validation/magnetometer/calibrate/live?spuId=...
 * Returns { position, moving }.
 */
export const GET: RequestHandler = async ({ url, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	const spuId = url.searchParams.get('spuId');
	if (!spuId) return json({ error: 'spuId is required' }, { status: 400 });

	await connectDB();

	const spu = (await Spu.findById(spuId).lean()) as any;
	if (!spu?.particleLink?.particleDeviceId) {
		return json({ error: 'SPU has no Particle device linked' }, { status: 400 });
	}

	const deviceId = spu.particleLink.particleDeviceId;

	try {
		const [pos, moving] = await Promise.all([
			getVariable(deviceId, 'stage_pos'),
			getVariable(deviceId, 'stage_moving')
		]);
		return json({
			position: typeof pos?.result === 'number' ? pos.result : null,
			moving: moving?.result === 1
		});
	} catch (err: any) {
		// Polling is best-effort — a dropped sample must not abort the move the
		// operator is watching, so this stays a soft failure the UI can ignore.
		return json(
			{ error: `Live read failed: ${err?.message ?? 'unknown error'}` },
			{ status: 502 }
		);
	}
};
