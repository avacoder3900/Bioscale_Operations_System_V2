/**
 * Sync each OT-2's on-robot protocol library into its OpentronsRobot.protocols[]
 * doc in Mongo. That embedded array is what the wax-filling / reagent-filling
 * Start Run panels read (src/routes/manufacturing/cart-mfg/*/+page.server.ts) —
 * uploading a protocol to a robot does NOT populate it on its own, which is why a
 * freshly-uploaded wax protocol never appears on the Wax page.
 *
 * For each robot (read from Mongo, reached at its .local host over the lab LAN):
 *   1. GET /protocols                       — every protocol on the robot
 *   2. GET /protocols/<id>/analyses         — latest analysis (params/labware/pipettes)
 *   3. derive protocolType from the .py filename:
 *        contains "wax"     -> 'wax-filling'
 *        contains "reagent" -> 'reagent-filling'
 *        else               -> 'other'
 *   4. $set protocols[] to the rebuilt list (tagged + analyzed)
 *
 * Must run on the lab Mac (needs LAN/mDNS access to the robots' .local hosts).
 * Reads MONGODB_URI from ../.env (same as the other scripts/*.ts).
 *
 *   npx tsx scripts/sync-robot-protocols.ts                                  # dry run (no writes)
 *   SYNC_APPLY=1 npx tsx scripts/sync-robot-protocols.ts                     # write to Mongo
 *   SYNC_ROBOT=OT2CEP20210817R04.local npx tsx scripts/sync-robot-protocols.ts   # one robot
 */

import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';
import { randomUUID } from 'node:crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const APPLY = process.env.SYNC_APPLY === '1';
const ONLY_HOST = process.env.SYNC_ROBOT?.trim() || null;
const PORT = 31950;
const OT_HEADERS = { 'opentrons-version': '*' };

function deriveProtocolType(filename: string): 'wax-filling' | 'reagent-filling' | 'other' {
	const f = (filename || '').toLowerCase();
	if (f.includes('wax')) return 'wax-filling';
	if (f.includes('reagent')) return 'reagent-filling';
	return 'other';
}

/** Main .py filename for a robot /protocols entry. */
function mainFileName(p: any): string {
	const files: any[] = p?.files ?? [];
	const py = files.find((f) => typeof f?.name === 'string' && f.name.endsWith('.py'));
	return py?.name ?? files[0]?.name ?? p?.metadata?.protocolName ?? p?.id ?? 'unknown';
}

async function robotGet(host: string, pathName: string): Promise<any> {
	const res = await fetch(`http://${host}:${PORT}${pathName}`, {
		headers: OT_HEADERS,
		signal: AbortSignal.timeout(20_000)
	});
	if (!res.ok) throw new Error(`GET ${pathName} -> ${res.status}`);
	return res.json();
}

/** Pull the latest analysis detail for one protocol (params/labware/pipettes). */
async function fetchAnalysis(host: string, protocolId: string): Promise<{
	status: string;
	parametersSchema: any;
	labwareDefinitions: any;
	pipettesRequired: any;
}> {
	const empty = { status: 'unknown', parametersSchema: null, labwareDefinitions: null, pipettesRequired: null };
	try {
		const list = await robotGet(host, `/protocols/${protocolId}/analyses`);
		const summaries: any[] = list?.data ?? [];
		if (summaries.length === 0) return empty;
		const latest = summaries[summaries.length - 1];
		// Some robot-server versions inline the analysis on the summary; others
		// require fetching the detail by id. Try the detail, fall back to inline.
		let a: any = latest;
		try {
			const detail = await robotGet(host, `/protocols/${protocolId}/analyses/${latest.id}`);
			a = detail?.data ?? latest;
		} catch {
			/* use inline summary */
		}
		const body = a?.result ?? a; // older API nested under .result
		return {
			status: a?.status ?? 'unknown',
			parametersSchema: body?.runTimeParameters ?? null,
			labwareDefinitions: body?.labware ?? null,
			pipettesRequired: body?.pipettes ?? null
		};
	} catch {
		return empty;
	}
}

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing (run on the lab Mac with ../.env present)');
	await mongoose.connect(process.env.MONGODB_URI);
	const coll = mongoose.connection.db!.collection('opentrons_robots');

	console.log(`\n=== Sync robot.protocols[] from robots  (mode: ${APPLY ? 'APPLY' : 'DRY RUN'}) ===\n`);

	let robots = await coll.find({ isActive: { $ne: false } }).toArray();
	if (ONLY_HOST) robots = robots.filter((r) => r.ip === ONLY_HOST);
	if (robots.length === 0) {
		console.log('No matching robots in Mongo.');
		await mongoose.disconnect();
		return;
	}

	for (const robot of robots) {
		const host = robot.ip;
		console.log(`\n→ ${robot.name}  (${host})`);
		console.log('─'.repeat(78));

		let onRobot: any[];
		try {
			const listed = await robotGet(host, '/protocols');
			onRobot = listed?.data ?? [];
		} catch (e) {
			console.log(`  UNREACHABLE — ${(e as Error).message}. Skipping (existing protocols[] left untouched).`);
			continue;
		}

		if (onRobot.length === 0) {
			console.log('  Robot reports 0 protocols. Skipping (not clobbering Mongo with an empty list).');
			continue;
		}

		const synced: any[] = [];
		for (const p of onRobot) {
			const filename = mainFileName(p);
			const protocolType = deriveProtocolType(filename);
			const analysis = await fetchAnalysis(host, p.id);
			synced.push({
				_id: randomUUID(),
				opentronsProtocolId: p.id,
				protocolName: filename,
				protocolType,
				fileHash: null,
				parametersSchema: analysis.parametersSchema,
				analysisStatus: analysis.status,
				analysisData: null,
				labwareDefinitions: analysis.labwareDefinitions,
				pipettesRequired: analysis.pipettesRequired,
				uploadedBy: 'sync-robot-protocols',
				createdAt: p.createdAt ? new Date(p.createdAt) : new Date(),
				updatedAt: new Date()
			});
			console.log(`  ${filename.padEnd(40)} type=${protocolType.padEnd(14)} analysis=${analysis.status} id=${String(p.id).slice(0, 8)}…`);
		}

		const byType = synced.reduce((m: Record<string, number>, s) => ((m[s.protocolType] = (m[s.protocolType] ?? 0) + 1), m), {});
		console.log(`  -> would set protocols[] = ${synced.length} (${Object.entries(byType).map(([k, v]) => `${v} ${k}`).join(', ')})`);

		if (APPLY) {
			await coll.updateOne({ _id: robot._id }, { $set: { protocols: synced, updatedAt: new Date() } });
			console.log('  WROTE.');
		}
	}

	if (!APPLY) console.log('\nDry run only. Re-run with  SYNC_APPLY=1  to write.\n');
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
