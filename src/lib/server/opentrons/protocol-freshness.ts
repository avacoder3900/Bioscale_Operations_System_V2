/**
 * Run-start deck-calibration freshness gate.
 *
 * A fill run executes whatever labware-definition SNAPSHOT was bundled into the
 * protocol at upload time — NOT the live Mongo calibration the Deck Calibration
 * Studio edits. Historically that meant a run could silently use stale geometry
 * whenever (a) calibration was edited without pressing Sync, (b) the fill page
 * was loaded before a Sync and posted the older protocol id, or (c) a deploy
 * script repointed the robot without updating the stored .py library.
 *
 * The gate closes all three holes at the moment that matters — run start. It
 * resolves the robot's CURRENT protocol entry server-side, fetches that upload's
 * own analysis from the robot, and diffs every BIMS-managed labware definition
 * it resolved (well x/y/z) against live Mongo. On any mismatch (or if the bundle
 * can't be verified) it re-uploads the stored protocol .py with the live defs,
 * repoints the robot's entry, VERIFIES the new bundle, and returns the fresh id.
 * It never lets a run start on geometry it could not prove current.
 *
 * OT2-TAILNET-5 split: the ROBOT half (the analyses diff, the upload) is the
 * shared 'run.ensureFresh' / 'run.uploadProtocol' verbs in
 * $lib/opentrons/ot2-protocol, run over either line. What is left here is the
 * BIMS half: the expected wells, the current entry, the stored .py, and the
 * records written when a re-sync happens. startRunSequence (ot2-protocol) puts
 * them in order; ensureFreshRunProtocol below is the same gate in one call.
 */
import {
	connectDB,
	LabwareDefinition,
	OpentronsRobot,
	OpentronProtocol,
	AuditLog,
	generateId
} from '$lib/server/db';
import { runVerb, type ExpectedWells, type UploadedProtocolResult, type ProcessType, type Line } from '$lib/opentrons/ot2-protocol';
import { assembleProtocolUpload, uploadAssembledProtocol } from './proxy';
import { serverTransport } from './transport';

export type FreshProtocol = {
	opentronsProtocolId: string;
	parametersSchema: Array<{ variableName: string; type?: string; default?: unknown }> | null;
	/** true when the gate re-uploaded because the robot-side bundle was stale */
	refreshed: boolean;
	detail: string;
};

/**
 * loadName → wellName → {x,y,z} from Mongo definitions — exactly the fields the
 * diff compares. Later definitions with the same loadName win, as the old Map did.
 */
export function expectedWellsFromDefs(defs: Array<{ loadName?: string; definition?: any }>): ExpectedWells {
	const out: ExpectedWells = {};
	for (const d of defs) {
		if (!d?.loadName) continue;
		const wells = d.definition?.wells ?? {};
		const slim: ExpectedWells[string] = {};
		for (const [wn, w] of Object.entries(wells as Record<string, any>)) {
			slim[wn] = { x: w?.x, y: w?.y, z: w?.z };
		}
		out[d.loadName] = slim;
	}
	return out;
}

/** Live Mongo geometry for every BIMS-managed labware definition. */
export async function loadExpectedWells(): Promise<ExpectedWells> {
	await connectDB();
	const defs = (await LabwareDefinition.find().select('loadName definition').lean()) as any[];
	return expectedWellsFromDefs(defs);
}

/** The robot's current (newest) protocol entry for a process, or null. */
export async function currentProtocolEntry(robotId: string, processType: ProcessType): Promise<any | null> {
	await connectDB();
	const robotDoc = (await OpentronsRobot.findById(robotId).lean()) as any;
	const entries = ((robotDoc?.protocols ?? []) as any[])
		.filter((p) => p.protocolType === processType && p.opentronsProtocolId)
		.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
	return entries[entries.length - 1] ?? null;
}

/** The stored .py to re-sync with; throws the operator-facing message when none. */
export async function storedRunProtocol(processType: ProcessType, staleDetail: string): Promise<{ fileName: string; fileContent: string }> {
	await connectDB();
	const proto = (await OpentronProtocol.findOne({ processType, isActive: true }).sort({ createdAt: -1 }).lean()) as any;
	if (!proto?.fileContent) {
		throw new Error(
			`Deck calibration is newer than the robot's ${processType} upload (${staleDetail}), ` +
				`and BIMS has no stored ${processType} .py to re-sync automatically. ` +
				`Sync from the Deck Calibration page, then start the run again.`
		);
	}
	return { fileName: proto.fileName ?? `${processType}.py`, fileContent: proto.fileContent };
}

/** The upload bundle for a re-sync (server half of 'run.uploadProtocol'). */
export async function resyncBundle(robot: any, processType: ProcessType, staleDetail: string) {
	const { fileName, fileContent } = await storedRunProtocol(processType, staleDetail);
	return assembleProtocolUpload(robot, fileName, fileContent);
}

/** Repoint the robot's entry for this process to a fresh upload. */
export async function recordResyncUpload(
	robotId: string,
	processType: ProcessType,
	fileName: string,
	uploaded: UploadedProtocolResult,
	username: string
): Promise<void> {
	await connectDB();
	await OpentronsRobot.updateOne({ _id: robotId }, { $pull: { protocols: { protocolType: processType } } });
	await OpentronsRobot.updateOne(
		{ _id: robotId },
		{
			$push: {
				protocols: {
					_id: generateId(),
					opentronsProtocolId: uploaded.opentronsProtocolId,
					protocolName: fileName,
					protocolType: processType,
					parametersSchema: uploaded.parametersSchema ?? null,
					analysisStatus: uploaded.analysisStatus,
					labwareDefinitions: uploaded.labwareDefinitions ?? null,
					pipettesRequired: uploaded.pipettesRequired ?? null,
					uploadedBy: `run-start auto-resync (${username})`,
					createdAt: new Date(),
					updatedAt: new Date()
				}
			}
		}
	);
}

/** The AuditLog row for a verified run-start re-sync. */
export async function auditResync(
	robotId: string,
	processType: ProcessType,
	from: string | null,
	to: string,
	reason: string,
	username: string,
	line: Line
): Promise<void> {
	await connectDB();
	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_robots',
		recordId: robotId,
		action: 'run_start_auto_resync',
		newData: { processType, from, to, reason, line },
		changedAt: new Date(),
		changedBy: username
	});
}

/**
 * The whole gate in one server call, over the server line (queue on Vercel).
 * Same order and messages as before the split; the fill pages now run the same
 * steps through startRunSequence.
 */
export async function ensureFreshRunProtocol(
	robot: any,
	robotId: string,
	processType: ProcessType,
	username: string
): Promise<FreshProtocol> {
	await connectDB();
	const t = serverTransport(robot);
	const current = await currentProtocolEntry(robotId, processType);
	const expectedWells = await loadExpectedWells();

	let staleDetail = 'no protocol entry on robot';
	if (current) {
		const r = await runVerb(t, 'run.ensureFresh', { protocolId: current.opentronsProtocolId, expectedWells });
		const b = r.body as any;
		if (r.status === 200 && b?.ok) {
			return {
				opentronsProtocolId: current.opentronsProtocolId,
				parametersSchema: current.parametersSchema ?? null,
				refreshed: false,
				detail: b.detail
			};
		}
		staleDetail = r.status === 200 ? b?.detail : `could not verify bundle: ${b?.message}`;
	}

	// Stale / unverifiable → re-upload the stored .py with the LIVE defs.
	const bundle = await resyncBundle(robot, processType, staleDetail);
	const uploaded = await uploadAssembledProtocol(robot, bundle);
	await recordResyncUpload(robotId, processType, bundle.fileName, uploaded, username);

	// Hard gate: prove the FRESH upload carries the live calibration before the
	// caller is allowed to start a run on it.
	const v = await runVerb(t, 'run.ensureFresh', {
		protocolId: uploaded.opentronsProtocolId,
		expectedWells,
		waitForCompletedMs: 120_000
	});
	if (v.status !== 200) throw new Error((v.body as any)?.message ?? 'verify failed');
	const verify = v.body as { ok: boolean; detail: string };
	if (!verify.ok) {
		throw new Error(`re-synced ${processType} protocol still doesn't match live calibration: ${verify.detail}`);
	}

	await auditResync(robotId, processType, current?.opentronsProtocolId ?? null, uploaded.opentronsProtocolId, staleDetail, username, 'queue');

	return {
		opentronsProtocolId: uploaded.opentronsProtocolId,
		parametersSchema: (uploaded.parametersSchema as any) ?? null,
		refreshed: true,
		detail: `auto-resynced (${staleDetail}); ${verify.detail}`
	};
}
