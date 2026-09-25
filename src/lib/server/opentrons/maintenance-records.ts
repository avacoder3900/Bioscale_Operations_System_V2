/**
 * The BIMS half of the maintenance verbs (OT2-TAILNET-4 option 1).
 *
 * Every maintenance verb has a ROBOT half (in $lib/opentrons/ot2-protocol, run
 * over either line) and possibly a BIMS half, which lives here and is always
 * executed on the server — whichever line moved the robot:
 *
 *   queue line   route → runVerb(serverTransport) → applyMaintenanceRecord()
 *   tailnet line browser → runVerb(robot) → POST /direct-record → applyMaintenanceRecord()
 *
 * Before the robot half, the labware verbs need BIMS data too: the definition
 * to register. resolveLabwareForRobot() is that lookup, used by the route and
 * by GET /api/opentrons-lab/labware/resolve (the browser's copy of it).
 */
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { resolveLabwareDefinition } from '$lib/server/services/deck-calibration/resolve';
import { profileForTiprack, recordStudioTipPickup } from './tip-cursor';
import type { MaintenanceRecord } from '$lib/opentrons/ot2-protocol';

export type Line = 'queue' | 'tailnet';

/**
 * Definition + identity to register on the robot. Identity comes from the blob
 * the robot indexes (falling back to the DB columns), exactly as the routes did.
 * Throws with a message when the labware isn't in BIMS (callers answer 404).
 */
export async function resolveLabwareForRobot(
	loadName: string,
	opts: { namespace?: string | null; version?: number | null } = {}
): Promise<{ definition: unknown; labwareNamespace: string; labwareVersion: number }> {
	const { doc: def } = (await resolveLabwareDefinition(loadName, {
		namespace: opts.namespace ?? null,
		version: opts.version ?? null,
		strict: true
	})) as { doc: any };
	return {
		definition: def.definition,
		labwareNamespace: def.definition?.namespace ?? def.namespace,
		labwareVersion: Number(def.definition?.version ?? def.version ?? 1)
	};
}

/**
 * Write what BIMS records after a successful robot verb. Returns fields to merge
 * into the verb's response (e.g. nextTipWell), so both lines answer identically.
 */
export async function applyMaintenanceRecord(
	robotId: string,
	username: string,
	rec: MaintenanceRecord,
	line: Line
): Promise<Record<string, unknown>> {
	if (rec.event === 'studio_tip_pickup') {
		// Advance the Studio's per-robot tip cursor so the next pick-up aims past this well.
		let nextTipWell: string | null = null;
		try {
			nextTipWell = await recordStudioTipPickup(robotId, profileForTiprack(rec.tiprackLoadName), rec.tipWell);
		} catch {
			/* best-effort, as before */
		}
		return { nextTipWell };
	}

	await connectDB();
	const { event, ...newData } = rec;
	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_robots',
		recordId: robotId,
		action: event,
		newData: { ...newData, line },
		changedAt: new Date(),
		changedBy: username
	});
	return {};
}
