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
 * ensureFreshRunProtocol() closes all three holes at the moment that matters —
 * run start. It resolves the robot's CURRENT protocol entry server-side,
 * fetches that upload's own analysis from the robot, and diffs every
 * BIMS-managed labware definition it resolved (well x/y/z) against live Mongo.
 * On any mismatch (or if the bundle can't be verified) it re-uploads the stored
 * protocol .py with the live defs, repoints the robot's entry, VERIFIES the new
 * bundle, and returns the fresh id. It never lets a run start on geometry it
 * could not prove current.
 */
import {
	connectDB,
	LabwareDefinition,
	OpentronsRobot,
	OpentronProtocol,
	AuditLog,
	generateId
} from '$lib/server/db';
import { robotGet, robotUploadProtocol } from './proxy';

const TOL = 1e-6;

export type FreshProtocol = {
	opentronsProtocolId: string;
	parametersSchema: Array<{ variableName: string; type?: string; default?: unknown }> | null;
	/** true when the gate re-uploaded because the robot-side bundle was stale */
	refreshed: boolean;
	detail: string;
};

type MongoDefs = Map<string, any>;

/**
 * Compare the labware definitions a protocol upload actually resolved (from its
 * on-robot analysis) against the live Mongo definitions. Only BIMS-managed
 * loadNames are compared — labware bundled from other sources isn't calibration.
 * Throws when the analysis can't be fetched (caller treats that as stale).
 */
async function bundledDefsMatchMongo(
	robot: any,
	protocolId: string,
	mongoDefs: MongoDefs,
	waitForCompletedMs = 0
): Promise<{ ok: boolean; detail: string }> {
	const deadline = Date.now() + waitForCompletedMs;
	let analysisId: string | null = null;
	for (;;) {
		const listRes = await robotGet(robot, `/protocols/${protocolId}/analyses`);
		if (!listRes.ok) throw new Error(`robot returned ${listRes.status} listing analyses`);
		const list = ((await listRes.json()) as any)?.data ?? [];
		const completed = list.filter((a: any) => a.status === 'completed');
		if (completed.length) {
			analysisId = completed[completed.length - 1].id;
			break;
		}
		if (list.some((a: any) => a.status === 'failed')) throw new Error('protocol analysis failed');
		if (Date.now() >= deadline) throw new Error('no completed analysis for protocol');
		await new Promise((r) => setTimeout(r, 3000));
	}
	const detRes = await robotGet(robot, `/protocols/${protocolId}/analyses/${analysisId}`);
	if (!detRes.ok) throw new Error(`robot returned ${detRes.status} fetching analysis`);
	const det = ((await detRes.json()) as any)?.data;
	if ((det?.errors ?? []).length) throw new Error('protocol analysis completed with errors');

	let checked = 0;
	for (const c of det?.commands ?? []) {
		if (c.commandType !== 'loadLabware') continue;
		const def = c.result?.definition;
		const loadName = def?.parameters?.loadName;
		if (!loadName || !mongoDefs.has(loadName)) continue;
		const want = mongoDefs.get(loadName)?.wells ?? {};
		const got = def.wells ?? {};
		for (const wn of Object.keys(want)) {
			const w = want[wn];
			const g = got[wn];
			if (!g) return { ok: false, detail: `${loadName} ${wn} missing from bundled def` };
			if (
				Math.abs((g.x ?? 0) - (w.x ?? 0)) > TOL ||
				Math.abs((g.y ?? 0) - (w.y ?? 0)) > TOL ||
				Math.abs((g.z ?? 0) - (w.z ?? 0)) > TOL
			) {
				return {
					ok: false,
					detail: `${loadName} ${wn} bundled (${g.x},${g.y},${g.z}) != current (${w.x},${w.y},${w.z})`
				};
			}
		}
		checked++;
	}
	if (!checked) return { ok: false, detail: 'analysis resolved no BIMS-managed labware' };
	return { ok: true, detail: `${checked} BIMS labware defs verified current` };
}

export async function ensureFreshRunProtocol(
	robot: any,
	robotId: string,
	processType: 'wax-filling' | 'reagent-filling',
	username: string
): Promise<FreshProtocol> {
	await connectDB();

	const robotDoc = (await OpentronsRobot.findById(robotId).lean()) as any;
	const entries = ((robotDoc?.protocols ?? []) as any[])
		.filter((p) => p.protocolType === processType && p.opentronsProtocolId)
		.sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
	const current = entries[entries.length - 1] ?? null;

	const defs = (await LabwareDefinition.find().select('loadName definition').lean()) as any[];
	const mongoDefs: MongoDefs = new Map(defs.map((d) => [d.loadName, d.definition]));

	let staleDetail = 'no protocol entry on robot';
	if (current) {
		try {
			const res = await bundledDefsMatchMongo(robot, current.opentronsProtocolId, mongoDefs);
			if (res.ok) {
				return {
					opentronsProtocolId: current.opentronsProtocolId,
					parametersSchema: current.parametersSchema ?? null,
					refreshed: false,
					detail: res.detail
				};
			}
			staleDetail = res.detail;
		} catch (e) {
			staleDetail = `could not verify bundle: ${e instanceof Error ? e.message : e}`;
		}
	}

	// Stale / unverifiable → re-upload the stored .py with the LIVE defs.
	const proto = (await OpentronProtocol.findOne({ processType, isActive: true })
		.sort({ createdAt: -1 })
		.lean()) as any;
	if (!proto?.fileContent) {
		throw new Error(
			`Deck calibration is newer than the robot's ${processType} upload (${staleDetail}), ` +
				`and BIMS has no stored ${processType} .py to re-sync automatically. ` +
				`Sync from the Deck Calibration page, then start the run again.`
		);
	}
	const fileName = proto.fileName ?? `${processType}.py`;
	const uploaded = await robotUploadProtocol(robot, fileName, new TextEncoder().encode(proto.fileContent));

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

	// Hard gate: prove the FRESH upload carries the live calibration before the
	// caller is allowed to start a run on it.
	const verify = await bundledDefsMatchMongo(robot, uploaded.opentronsProtocolId, mongoDefs, 120_000);
	if (!verify.ok) {
		throw new Error(`re-synced ${processType} protocol still doesn't match live calibration: ${verify.detail}`);
	}

	await AuditLog.create({
		_id: generateId(),
		tableName: 'opentrons_robots',
		recordId: robotId,
		action: 'run_start_auto_resync',
		newData: {
			processType,
			from: current?.opentronsProtocolId ?? null,
			to: uploaded.opentronsProtocolId,
			reason: staleDetail
		},
		changedAt: new Date(),
		changedBy: username
	});

	return {
		opentronsProtocolId: uploaded.opentronsProtocolId,
		parametersSchema: (uploaded.parametersSchema as any) ?? null,
		refreshed: true,
		detail: `auto-resynced (${staleDetail}); ${verify.detail}`
	};
}
