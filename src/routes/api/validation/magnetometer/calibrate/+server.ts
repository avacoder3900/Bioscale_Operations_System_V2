import { json } from '@sveltejs/kit';
import { connectDB, Spu } from '$lib/server/db';
import { callFunction } from '$lib/server/particle';
import type { RequestHandler } from './$types';

export const config = {
	maxDuration: 60
};

// Mirrors firmware brevitest-firmware.h — used only for a friendly pre-check;
// the firmware enforces its own range and returns -1 on a bad argument.
const STAGE_POSITION_LIMIT = 45000;

type CalibrateAction = 'pos' | 'home' | 'jog' | 'goto';

/**
 * Proxy for the firmware `stage_control` cloud function (v89+).
 *
 * Body: { spuId, action: 'pos' | 'home' | 'jog' | 'goto', microns? }
 *  - pos:  report current stage position (no motion)
 *  - home: re-home against the proximal limit switch (position 0)
 *  - jog:  relative move by `microns` (+ away from the limit switch)
 *  - goto: re-home, then drive out to absolute `microns` — every approach
 *          is zeroed at the limit switch
 *
 * Returns { position } in microns from the limit-switch zero.
 */
export const POST: RequestHandler = async ({ request, locals }) => {
	if (!locals.user) return json({ error: 'Unauthorized' }, { status: 401 });

	let body: { spuId?: string; action?: CalibrateAction; microns?: number };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	const { spuId, action } = body;
	const microns = typeof body.microns === 'number' ? Math.trunc(body.microns) : null;

	if (!spuId) return json({ error: 'spuId is required' }, { status: 400 });
	if (!action || !['pos', 'home', 'jog', 'goto'].includes(action)) {
		return json({ error: 'action must be pos, home, jog or goto' }, { status: 400 });
	}

	let arg: string;
	if (action === 'jog') {
		if (!microns) return json({ error: 'jog requires a non-zero microns value' }, { status: 400 });
		arg = `jog,${microns}`;
	} else if (action === 'goto') {
		if (microns === null || microns < 0 || microns > STAGE_POSITION_LIMIT) {
			return json(
				{ error: `goto requires microns between 0 and ${STAGE_POSITION_LIMIT}` },
				{ status: 400 }
			);
		}
		arg = `goto,${microns}`;
	} else {
		arg = action;
	}

	await connectDB();

	const spu = (await Spu.findById(spuId).lean()) as any;
	if (!spu?.particleLink?.particleDeviceId) {
		return json({ error: 'SPU has no Particle device linked' }, { status: 400 });
	}

	try {
		const result = await callFunction(
			spu.particleLink.particleDeviceId,
			'stage_control',
			arg
		);
		if (result.return_value < 0) {
			return json(
				{ error: `Device rejected stage_control "${arg}" (returned ${result.return_value}). Firmware v89+ required.` },
				{ status: 422 }
			);
		}
		return json({ position: result.return_value });
	} catch (err: any) {
		return json(
			{ error: `Device call failed: ${err?.message ?? 'unknown error'}. Is the SPU online?` },
			{ status: 502 }
		);
	}
};
