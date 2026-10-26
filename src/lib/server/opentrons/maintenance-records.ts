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
import { getRackOffset, rackSlotFor, isZero } from '$lib/server/services/deck-calibration/rack-offsets';
import { profileForTiprack, recordStudioTipPickup } from './tip-cursor';
import type { MaintenanceRecord, LabwareOffsetArg } from '$lib/opentrons/ot2-protocol';

export type Line = 'queue' | 'tailnet';

/**
 * Definition + identity to register on the robot. Identity comes from the blob
 * the robot indexes (falling back to the DB columns), exactly as the routes did.
 * Throws with a message when the labware isn't in BIMS (callers answer 404).
 *
 * CALIB-5: with `robotId` + `slot`, a rack (slot 10 tube rack / slot 11 tip
 * rack, see RACK_SLOT_FOR_LOAD_NAME) also gets THIS robot's `labwareOffset`
 * — the vector the maintenance verb registers on the run before loading, so
 * Move-to-hole and Pick-up land where the fill will. Omitted when the robot
 * has no row, the vector is zero, the labware is not a rack, or the slot does
 * not match the rack's (a rack loaded elsewhere is not the fill's rack).
 */
export async function resolveLabwareForRobot(
	loadName: string,
	opts: { namespace?: string | null; version?: number | null; robotId?: string | null; slot?: string | null } = {}
): Promise<{ definition: unknown; labwareNamespace: string; labwareVersion: number; labwareOffset?: LabwareOffsetArg }> {
	const { doc: def, uri } = (await resolveLabwareDefinition(loadName, {
		namespace: opts.namespace ?? null,
		version: opts.version ?? null,
		strict: true
	})) as { doc: any; uri: string };
	const labwareNamespace: string = def.definition?.namespace ?? def.namespace;
	const labwareVersion = Number(def.definition?.version ?? def.version ?? 1);
	const out = { definition: def.definition, labwareNamespace, labwareVersion };

	const rackSlot = rackSlotFor(loadName);
	if (!rackSlot || !opts.robotId || opts.slot == null || String(opts.slot) !== rackSlot) return out;
	// Keyed in BIMS on the resolver's URI (DB columns); registered on the robot
	// under the identity the robot indexes (the blob's namespace/version — the same
	// identity loadLabwareInRun compares against), so the engine binds it at load.
	const row = await getRackOffset(String(opts.robotId), uri, rackSlot);
	if (!row || isZero(row.vector)) return out;
	return {
		...out,
		labwareOffset: {
			definitionUri: `${labwareNamespace}/${loadName}/${labwareVersion}`,
			slotName: rackSlot,
			vector: { x: row.vector.x, y: row.vector.y, z: row.vector.z }
		}
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
