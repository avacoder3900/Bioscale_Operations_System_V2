/**
 * Read-only: list every protocol cached on every OpentronsRobot in BIMS,
 * with extra detail for any whose protocolName matches "Wax Filling" or
 * "Reagent Filling GEN4". Tells us whether the GEN4 protocols are visible
 * to the clone, and what runtime parameters / pipettes / labware they
 * declare — needed to wire them into the wax/reagent filling flows.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const robots = await db.collection('opentrons_robots').find({}).toArray();
	console.log(`\n=== OpentronsRobot rows: ${robots.length} ===\n`);

	for (const r of robots as any[]) {
		const protos = r.protocols ?? [];
		console.log(`Robot ${r._id}  name="${r.name ?? ''}"  ip=${r.ip ?? '?'}  active=${r.isActive}  healthOk=${r.lastHealthOk}  protocols=${protos.length}`);
		for (const p of protos) {
			const flag = /wax\s*filling|reagent\s*filling.*gen.?4|gen.?4.*reagent/i.test(p.protocolName ?? '') ? '  <-- MATCH' : '';
			console.log(`    - "${p.protocolName ?? '(no name)'}"  type=${p.protocolType ?? '?'}  status=${p.analysisStatus ?? '?'}  opentronsId=${p.opentronsProtocolId ?? '?'}${flag}`);
		}
	}

	// Detail dump for matching protocols only
	console.log('\n=== Detail: matched protocols ===\n');
	for (const r of robots as any[]) {
		for (const p of (r.protocols ?? []) as any[]) {
			if (!/wax\s*filling|reagent\s*filling.*gen.?4|gen.?4.*reagent/i.test(p.protocolName ?? '')) continue;
			console.log(`--- ${p.protocolName} (robot ${r.name ?? r._id}) ---`);
			console.log(`  opentronsProtocolId: ${p.opentronsProtocolId}`);
			console.log(`  protocolType: ${p.protocolType}`);
			console.log(`  analysisStatus: ${p.analysisStatus}`);
			console.log(`  pipettesRequired: ${JSON.stringify(p.pipettesRequired ?? null, null, 2)}`);
			console.log(`  labwareDefinitions: ${Array.isArray(p.labwareDefinitions) ? `${p.labwareDefinitions.length} item(s)` : JSON.stringify(p.labwareDefinitions ?? null)}`);
			console.log(`  parametersSchema: ${JSON.stringify(p.parametersSchema ?? null, null, 2)}`);
			// analysisData can be huge — just show top-level keys + runTimeParameters
			const ad = p.analysisData ?? {};
			console.log(`  analysisData keys: ${Object.keys(ad).join(', ')}`);
			if (ad.runTimeParameters) {
				console.log(`  runTimeParameters:`);
				for (const rp of ad.runTimeParameters as any[]) {
					console.log(`    - ${rp.variableName} (${rp.type})  display="${rp.displayName}"  default=${JSON.stringify(rp.default)}${rp.min !== undefined ? `  range=[${rp.min}, ${rp.max}]` : ''}${rp.choices ? `  choices=${rp.choices.length}` : ''}`);
				}
			}
			if (ad.commands) {
				console.log(`  commands: ${ad.commands.length} step(s)`);
			}
			console.log('');
		}
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
