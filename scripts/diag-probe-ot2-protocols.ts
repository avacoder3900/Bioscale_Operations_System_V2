/**
 * Read-only: probe each OpentronsRobot directly over its OT-2 HTTP API
 * (port 31950) and list the protocols stored on the robot itself. The BIMS
 * `opentrons_robots.protocols[]` cache was empty, so the robot is the only
 * remaining source of truth.
 *
 * Will skip any robot that doesn't answer within 4s — typically means the
 * mDNS .local hostname only resolves on the lab WiFi.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const URI = process.env.MONGODB_URI!;
const HEADERS = { 'Opentrons-Version': '*' };

async function probe(host: string, path: string) {
	const url = `http://${host}:31950${path}`;
	const resp = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(4000) });
	if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
	return resp.json();
}

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const robots = await db.collection('opentrons_robots').find({}).toArray();

	for (const r of robots as any[]) {
		const host = r.ip;
		console.log(`\n=== ${r.name} (${host}) ===`);
		try {
			const health = await probe(host, '/health');
			console.log(`  health: name=${health.name}  api=${health.api_version}  fw=${health.fw_version}`);
		} catch (e) {
			console.log(`  health: UNREACHABLE (${e instanceof Error ? e.message : e})`);
			continue;
		}

		try {
			const protocolsResp = await probe(host, '/protocols');
			const protos = protocolsResp.data ?? [];
			console.log(`  protocols on robot: ${protos.length}`);
			for (const p of protos as any[]) {
				const meta = p.metadata ?? {};
				const name = meta.protocolName ?? p.id;
				console.log(`    - "${name}"  id=${p.id}  author="${meta.author ?? ''}"  created=${p.createdAt ?? ''}`);
				if (/wax\s*filling|reagent\s*filling.*gen.?4|gen.?4.*reagent/i.test(name)) {
					console.log(`      ^^^ MATCH — fetching latest analysis...`);
					const analyses = p.analysisSummaries ?? [];
					if (analyses.length === 0) {
						console.log(`      (no analyses)`);
						continue;
					}
					const latestId = analyses[analyses.length - 1].id;
					try {
						const aResp = await probe(host, `/protocols/${p.id}/analyses/${latestId}`);
						const a = aResp.data ?? {};
						const params = a.runTimeParameters ?? [];
						console.log(`      runTimeParameters: ${params.length}`);
						for (const rp of params) {
							const range = rp.min !== undefined ? `  range=[${rp.min}, ${rp.max}]` : '';
							const choices = rp.choices ? `  choices=${rp.choices.map((c: any) => c.value).join('|')}` : '';
							console.log(`        - ${rp.variableName} (${rp.type})  display="${rp.displayName}"  default=${JSON.stringify(rp.default)}${range}${choices}`);
							if (rp.description) console.log(`            desc: ${rp.description}`);
						}
						const pipettes = a.pipettes ?? [];
						console.log(`      pipettes: ${pipettes.map((p: any) => `${p.pipetteName}@${p.mount}`).join(', ') || '(none)'}`);
						const labware = a.labware ?? [];
						console.log(`      labware: ${labware.length} item(s)`);
						for (const lw of labware.slice(0, 12)) {
							console.log(`        - ${lw.loadName ?? lw.definitionUri ?? '?'}  @ ${lw.location?.slotName ?? lw.location?.moduleId ?? '?'}`);
						}
						const cmds = a.commands ?? [];
						console.log(`      commands: ${cmds.length} step(s)`);
						const meta2 = a.metadata ?? meta;
						if (meta2.estimatedRuntimeSeconds) console.log(`      estimatedRuntimeSeconds: ${meta2.estimatedRuntimeSeconds}`);
					} catch (e) {
						console.log(`      analysis fetch failed: ${e instanceof Error ? e.message : e}`);
					}
				}
			}
		} catch (e) {
			console.log(`  /protocols fetch failed: ${e instanceof Error ? e.message : e}`);
		}
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
