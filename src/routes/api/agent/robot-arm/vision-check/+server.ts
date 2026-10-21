/**
 * ARM-05 — "is the arm back home?" for automation.
 *
 * The fail state this is the backstop for: a task or replay ends and the arm
 * did not return to home. A caller (a task runner, an agent) hits this after a
 * run; it reads the encoders, has the Pi find every calibrated AprilTag in a
 * fresh frame (pose in mm, camera bumps undone via fixed tags) and answers with one verdict.
 * No motion — returning the arm is a human decision on the Vision tab.
 *
 *   GET /api/agent/robot-arm/vision-check[?camera=<name>]
 *   200 { verdict: 'home' | 'position_off' | 'markers_off' | 'camera_moved' | 'unverified' | …, ok, message, markers[], residuals, strained[], warnings }
 *   ok is true only when the encoders AND the arm tags both say home; either side missing → 'unverified'.
 *   404 no calibration; 502 the arm/camera could not be reached
 */
import { json } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import { checkHome } from '$lib/server/robot-arm-vision';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	try {
		const r = await checkHome({ _id: 'agent', username: 'agent-api' }, { cameraName: url.searchParams.get('camera'), kind: 'agent' });
		return json({
			verdict: r.home.verdict,
			ok: r.home.verdict === 'home',
			message: r.message,
			calibrationId: r.calibrationId,
			cameraName: r.cameraName,
			visionVerdict: r.vision?.verdict ?? null,
			cameraShift: r.vision?.cameraShift ?? null,
			markers: (r.vision?.markers ?? []).map((m) => ({
				markerId: m.markerId,
				tagId: m.tagId,
				name: m.name,
				group: m.group,
				role: m.role,
				status: m.status,
				offMm: m.offMm,
				offDeg: m.offDeg,
				center: m.center,
				zMm: m.zMm,
				depthMm: m.depthMm
			})),
			residuals: r.residuals,
			strained: r.home.strained,
			warnings: r.warnings
		});
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return json({ error: msg }, { status: msg.startsWith('no vision calibration') ? 404 : 502 });
	}
};
