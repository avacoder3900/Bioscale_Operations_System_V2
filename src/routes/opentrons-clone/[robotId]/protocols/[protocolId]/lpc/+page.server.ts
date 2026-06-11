/**
 * Labware Position Check wizard — server load.
 *
 * Reads the latest completed analysis so the client has the protocol's
 * required pipette(s) and slot-based labware. Nothing here mutates robot
 * state: the wizard drives the maintenance run through the existing
 * /api/opentrons-clone/robots/:r/maintenance endpoints once the page loads.
 */
import { error } from '@sveltejs/kit';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { connectDB, OpentronsRobot } from '$lib/server/db';
import { createRobotClient } from '$lib/server/opentrons/client';
import { requirePermission } from '$lib/server/permissions';
import type { PageServerLoad } from './$types';

const LOCAL_LABWARE_DIR = join(homedir(), 'Library', 'Application Support', 'Opentrons', 'labware');

/**
 * Read every custom labware JSON the Mac has registered locally and key it
 * by `namespace/loadName/version` (the shape used in analysis.labware
 * definitionUri strings). The LPC wizard uses this to register custom
 * definitions onto the maintenance run before calling loadLabware, because
 * a maintenance session doesn't automatically inherit the protocol's
 * labware like a normal run does.
 *
 * Returns a map { definitionUri → LabwareDefinition2/3 }. If the local
 * folder isn't readable, returns an empty map — the wizard will fall back
 * to namespace-lookup only (works for standard Opentrons labware only).
 */
async function loadLocalLabwareMap(): Promise<Record<string, unknown>> {
	const map: Record<string, unknown> = {};
	let files: string[];
	try {
		files = (await readdir(LOCAL_LABWARE_DIR)).filter((f) => f.endsWith('.json'));
	} catch {
		return map;
	}
	for (const f of files) {
		try {
			const raw = await readFile(join(LOCAL_LABWARE_DIR, f), 'utf-8');
			const def = JSON.parse(raw);
			const ns = def?.namespace;
			const loadName = def?.parameters?.loadName;
			const version = def?.version;
			if (ns && loadName && typeof version === 'number') {
				map[`${ns}/${loadName}/${version}`] = def;
			}
		} catch {
			// ignore malformed
		}
	}
	return map;
}

interface RobotDoc {
	_id: string;
	name: string;
	ip: string;
	port?: number;
}

export const load: PageServerLoad = async ({ params, locals }) => {
	requirePermission(locals.user, 'manufacturing:write');
	await connectDB();

	const robot = (await OpentronsRobot.findById(params.robotId)
		.select('_id name ip port')
		.lean()) as RobotDoc | null;
	if (!robot) throw error(404, 'Robot not found');

	const client = createRobotClient({ ip: robot.ip, port: robot.port }, { timeoutMs: 5000 });

	let protocol: any = null;
	let latestAnalysis: any = null;
	let instruments: any[] = [];
	let online = true;
	let instrumentsReachable = true;

	try {
		const detailRes = await (client as any).GET('/protocols/{protocolId}', {
			params: { path: { protocolId: params.protocolId } }
		});
		if (detailRes.error !== undefined) {
			if (detailRes.response.status === 404) throw error(404, 'Protocol not found');
			online = false;
		} else {
			protocol = detailRes.data?.data ?? null;
		}

		const analysesRes = await (client as any).GET('/protocols/{protocolId}/analyses', {
			params: { path: { protocolId: params.protocolId } }
		});
		if (analysesRes.error === undefined) {
			const analyses = analysesRes.data?.data ?? [];
			const latest = analyses[analyses.length - 1];
			if (latest?.id) {
				const detailAnalysisRes = await (client as any).GET(
					'/protocols/{protocolId}/analyses/{analysisId}',
					{ params: { path: { protocolId: params.protocolId, analysisId: latest.id } } }
				);
				if (detailAnalysisRes.error === undefined) {
					latestAnalysis = detailAnalysisRes.data?.data ?? null;
				}
			}
		}
	} catch (e: any) {
		if (e?.status) throw e;
		online = false;
	}

	try {
		const res = await (client as any).GET('/instruments', {});
		if (res.error !== undefined) instrumentsReachable = false;
		else instruments = res.data?.data ?? [];
	} catch {
		instrumentsReachable = false;
	}

	// Narrow to the labware definitions this protocol actually uses, keyed by
	// the same URI format the wizard sees in analysis.labware[].definitionUri.
	const allLocalDefs = await loadLocalLabwareMap();
	const neededUris = new Set<string>(
		(latestAnalysis?.labware ?? [])
			.map((lw: any) => lw?.definitionUri)
			.filter((u: unknown): u is string => typeof u === 'string')
	);
	const customDefs: Record<string, unknown> = {};
	for (const uri of neededUris) {
		if (allLocalDefs[uri]) customDefs[uri] = allLocalDefs[uri];
	}

	return {
		robot: JSON.parse(JSON.stringify(robot)),
		protocolId: params.protocolId,
		online,
		protocol: JSON.parse(JSON.stringify(protocol)),
		latestAnalysis: JSON.parse(JSON.stringify(latestAnalysis)),
		instruments: JSON.parse(JSON.stringify(instruments)),
		instrumentsReachable,
		customLabwareDefs: customDefs
	};
};
