/**
 * Dumps research-v2's protocol_definitions collection. Confirms whether the
 * Excel parser has populated a SuperQD Phase 1 protocol that BIMS could mirror.
 *
 * Run: npx tsx scripts/diag-protocol-definitions.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const col = db.collection('protocol_definitions');
	const all = await col.find({}).toArray();

	console.log(`=== protocol_definitions (${all.length} docs) ===\n`);

	for (const doc of all) {
		console.log('----------------------------------------------------------------');
		console.log(`Name:    ${doc.name}`);
		console.log(`Slug:    ${doc.slug ?? '-'}`);
		console.log(`Version: ${doc.version ?? '-'}`);
		console.log(`Status:  ${doc.status ?? '-'}`);
		console.log(`Source:  ${doc.sourceFile ?? doc.source ?? '-'}`);
		console.log(`Updated: ${doc.updatedAt ?? doc.lastUpdatedAt ?? '-'}`);
		console.log(`Params:  ${(doc.parameters ?? doc.inputs ?? []).length}`);
		console.log(`Steps:   ${(doc.steps ?? doc.stepRecords ?? []).length}`);
		console.log(`Materials: ${(doc.materials ?? doc.reagents ?? []).length}`);
	}

	console.log('\n================================================================');
	const qd = all.find(
		(d) =>
			/superqd|super.?quantum|QD.*phase|quantum.*phase|phase.*1/i.test(String(d.name ?? '')) ||
			/superqd/i.test(String(d.slug ?? ''))
	);
	if (qd) {
		console.log(`FOUND a possible SuperQD match: "${qd.name}" (slug=${qd.slug}, status=${qd.status})`);
		console.log('\nFull dump:\n');
		console.log(JSON.stringify(qd, null, 2));
	} else {
		console.log('NO SuperQD Phase 1 protocol_definition found in research-v2.');
		console.log('Implication: research-v2 has not parsed this Excel, so BIMS');
		console.log('cannot mirror a research-v2 structure that does not exist.');
		console.log('The Excel needs to either be parsed by research-v2 first,');
		console.log('or hand-translated directly into the BIMS template.');
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
