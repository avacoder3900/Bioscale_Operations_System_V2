/**
 * Sync a repo protocol .py into the stored OpentronProtocol.fileContent.
 *
 * BIMS uploads protocols from the stored source, not from the repo, and the
 * run-start freshness gate compares WELL COORDINATES only — it will not notice
 * that the .py itself changed. So a protocol edit reaches a robot in two steps:
 * refresh the stored source (here), then Sync to push it.
 *
 * Usage:
 *   MONGODB_URI=... npx tsx scripts/refresh-protocol-source.ts --type wax-filling [--apply]
 *   MONGODB_URI=... npx tsx scripts/refresh-protocol-source.ts --type reagent-filling --apply
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const argv = process.argv.slice(2);
const arg = (n: string) => {
	const i = argv.indexOf('--' + n);
	return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
};
const MODE: 'plan' | 'apply' = argv.includes('--apply') ? 'apply' : 'plan';
const processType = arg('type');

const FILE_FOR: Record<string, string> = {
	'wax-filling': 'protocols/Wax_Filling_GEN7_Cartridge.py',
	'reagent-filling': 'protocols/Reagent_Filling_GEN7.py'
};

if (!processType || !FILE_FOR[processType]) {
	console.error('Usage: --type wax-filling|reagent-filling [--apply]');
	process.exit(1);
}

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] ${db.databaseName}\n`);

	const path = FILE_FOR[processType!];
	const local = fs.readFileSync(path, 'utf8');
	const localHash = crypto.createHash('sha256').update(local).digest('hex');

	const rows = await db.collection('opentrons_protocols')
		.find({ processType, isActive: true }).sort({ createdAt: -1 }).limit(1).toArray();
	const p = rows[0] as any;
	if (!p) { console.error(`No active ${processType} protocol row. Refusing.`); process.exit(1); }

	const storedHash = crypto.createHash('sha256').update(String(p.fileContent ?? '')).digest('hex');
	console.log(`processType   ${processType}`);
	console.log(`local file    ${path} (${local.length} bytes)`);
	console.log(`stored sha256 ${storedHash.slice(0, 16)}`);
	console.log(`local sha256  ${localHash.slice(0, 16)}  ${storedHash === localHash ? '(already current)' : '(will refresh)'}`);

	if (storedHash === localHash) { console.log('\nNothing to do.'); await mongoose.disconnect(); return; }
	if (MODE === 'plan') {
		console.log('\nRe-run with --apply to write, then SYNC to each robot.');
		await mongoose.disconnect();
		return;
	}

	await db.collection('opentrons_protocols').updateOne(
		{ _id: p._id },
		{ $set: { fileContent: local, fileHash: localHash, updatedAt: new Date() } }
	);
	await db.collection('audit_log').insertOne({
		_id: 'rps-' + crypto.randomBytes(8).toString('hex'),
		tableName: 'opentrons_protocols',
		recordId: String(p._id),
		action: 'refresh_protocol_source',
		oldData: { fileHash: storedHash },
		newData: { fileHash: localHash, processType },
		changedAt: new Date(),
		changedBy: 'system-refresh-protocol-source'
	} as any);
	console.log('\nREFRESHED. Now Sync this protocol to each robot that should get it.');
	await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
