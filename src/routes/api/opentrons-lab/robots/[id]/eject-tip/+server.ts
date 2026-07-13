/**
 * Eject a broken tip into the trash.
 * POST /api/opentrons-lab/robots/:id/eject-tip
 * Returns: { ejected: true }
 *
 * Used by tip-break recovery. Stopping a protocol run resets the run engine's tip state,
 * so a broken tip is still physically on the pipette while the robot believes the mount is
 * empty — the next run would drive a fresh tip straight down onto it. This opens a
 * maintenance run, homes, moves over the trash and ejects whatever is there, regardless of
 * what the engine believes.
 *
 * Self-contained on purpose (opens and closes its own maintenance run) so the UI can call
 * it as one action without owning any robot state.
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { requirePermission } from '$lib/server/permissions';
import { getRobot } from '$lib/server/opentrons/proxy';
import {
	openMaintenanceRun,
	closeMaintenanceRun,
	discoverPipette,
	loadPipetteInRun,
	home,
	ejectTipToTrash
} from '$lib/server/opentrons/maintenance';

// Homing (~30s) + the move to the trash + the eject. Comfortably over Vercel's default.
export const config = { maxDuration: 120 };

export const POST: RequestHandler = async ({ params, locals, request }) => {
	if (!locals.user) error(401, 'Not authenticated');
	requirePermission(locals.user, 'manufacturing:write');

	const robot = await getRobot(params.id);
	if (!robot) error(404, 'Robot not found');

	const body = await request.json().catch(() => ({}) as any);
	const wantMount = body?.mount as 'left' | 'right' | undefined;

	let runId: string | null = null;
	try {
		const pip = await discoverPipette(robot as any, wantMount);
		if (!pip?.pipetteName) {
			error(400, 'No pipette is attached to this robot — nothing to eject a tip from.');
		}

		({ runId } = await openMaintenanceRun(robot as any));
		const pipetteId = await loadPipetteInRun(robot as any, runId, pip.pipetteName, pip.mount);

		// Position is unknown after a run is stopped, and the move to the trash refuses to
		// run on unhomed axes — so home first, every time.
		await home(robot as any, runId);
		await ejectTipToTrash(robot as any, runId, pipetteId);
		await home(robot as any, runId);

		return json({ ejected: true, mount: pip.mount, pipetteName: pip.pipetteName });
	} catch (e) {
		if ((e as any)?.status) throw e;
		const msg = e instanceof Error ? e.message : String(e);
		console.error('[API] eject-tip failed:', msg);
		error(502, `Could not eject the tip: ${msg}`);
	} finally {
		if (runId) {
			// Best-effort: leaving a maintenance run open wedges the engine for every later
			// operation (see the 2026-07-13 R04 incident).
			await closeMaintenanceRun(robot as any, runId).catch((e) =>
				console.error('[API] eject-tip: close maintenance run failed:', e)
			);
		}
	}
};
