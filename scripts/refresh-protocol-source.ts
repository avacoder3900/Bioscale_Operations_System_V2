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
 *   MONGODB_URI=... npx tsx scripts/refresh-protocol-source.ts --type wax-filling-arm-stage --apply
 *
 * The row is matched by processType AND fileName: two 'wax-filling' rows live
 * side by side (the carriage .py and the robot-arm stage .py), and refreshing
 * "the newest wax-filling row" would write one file's source into the other's row.
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

const FILE_FOR: Record<string, { processType: string; path: string }> = {
	'wax-filling': { processType: 'wax-filling', path: 'protocols/Wax_Filling_GEN7_Cartridge.py' },
	'reagent-filling': { processType: 'reagent-filling', path: 'protocols/Reagent_Filling_GEN7.py' },
	// The robot-arm stage variant is ALSO processType 'wax-filling' (the arm's OT-2
	// runs it as its wax-filling protocol); its row is told apart by fileName.
	'wax-filling-arm-stage': { processType: 'wax-filling', path: 'protocols/Wax_Filling_GEN7_ArmStage.py' }
};

if (!processType || !FILE_FOR[processType]) {
	console.error('Usage: --type wax-filling|reagent-filling|wax-filling-arm-stage [--apply]');
	process.exit(1);
}

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] ${db.databaseName}\n`);

	const { processType: rowType, path } = FILE_FOR[processType!];
	const fileName = path.split('/').pop()!;
	const local = fs.readFileSync(path, 'utf8');
	const localHash = crypto.createHash('sha256').update(local).digest('hex');

	const rows = await db.collection('opentrons_protocols')
		.find({ processType: rowType, fileName, isActive: true }).sort({ createdAt: -1 }).limit(1).toArray();
	const p = rows[0] as any;
	if (!p) { console.error(`No active ${rowType} protocol row with fileName ${fileName}. Upload it on /opentrons (Robots -> Protocols) first. Refusing.`); process.exit(1); }

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
		newData: { fileHash: localHash, processType: rowType, fileName },
		changedAt: new Date(),
		changedBy: 'system-refresh-protocol-source'
	} as any);
	console.log('\nREFRESHED. Now Sync this protocol to each robot that should get it.');
	await mongoose.disconnect();
}

main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
