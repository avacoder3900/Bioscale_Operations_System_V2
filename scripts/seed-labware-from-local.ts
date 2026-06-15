/**
 * Seed the BIMS labware library (labware_definitions) from the lab Mac's local
 * Opentrons labware dir (~/Library/Application Support/Opentrons/labware/*.json).
 * Idempotent upsert on (namespace, loadName, version).
 *
 * Run on the lab Mac (needs ../.env with MONGODB_URI):
 *   npx tsx scripts/seed-labware-from-local.ts
 */
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';
import { readdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });
const LW = path.join(homedir(), 'Library', 'Application Support', 'Opentrons', 'labware');

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
	await mongoose.connect(process.env.MONGODB_URI);
	const col = mongoose.connection.db!.collection('labware_definitions');
	let n = 0, skipped = 0;
	for (const f of readdirSync(LW).filter((f) => f.endsWith('.json'))) {
		const def = JSON.parse(readFileSync(path.join(LW, f), 'utf8'));
		const namespace = def.namespace, loadName = def.parameters?.loadName, version = def.version ?? 1;
		if (!namespace || !loadName) { console.log('skip (not labware):', f); skipped++; continue; }
		await col.updateOne(
			{ namespace, loadName, version },
			{
				$set: {
					displayName: def.metadata?.displayName ?? loadName,
					category: def.metadata?.displayCategory ?? 'Other',
					fileName: f, definition: def, uploadedBy: 'seed', updatedAt: new Date()
				},
				$setOnInsert: { _id: randomUUID(), createdAt: new Date() }
			},
			{ upsert: true }
		);
		console.log('  upserted', namespace + '/' + loadName + ' v' + version);
		n++;
	}
	console.log(`\nseeded ${n} labware defs (${skipped} skipped)`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
