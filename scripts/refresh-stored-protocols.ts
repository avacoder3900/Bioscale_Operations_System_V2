/**
 * Refresh the stored source of the active wax / reagent protocols from the
 * repo's protocols/*.py, so the next Sync or run-start re-upload delivers the
 * CALIB-5 .py (tiprack_offset_* / tuberack_offset_* RTPs) to the robots.
 *
 * Same pattern as scripts/set-tip-adjust-cap.ts part 2: `opentrons_protocols`
 * row {processType, isActive:true} newest first; fileContent + fileHash updated;
 * one audit row. Plan is the default.
 *
 *   MONGODB_URI=... npx tsx scripts/refresh-stored-protocols.ts            # plan
 *   MONGODB_URI=... npx tsx scripts/refresh-stored-protocols.ts --apply    # write
 *   ... --only wax|reagent
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const argv = process.argv.slice(2);
const MODE: 'plan' | 'apply' = argv.includes('--apply') ? 'apply' : 'plan';
const onlyIdx = argv.indexOf('--only');
const ONLY = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
const OPERATOR = 'claude-code';
const TARGETS = [
	{ key: 'wax', processType: 'wax-filling', py: 'protocols/Wax_Filling_GEN7_Cartridge.py', mustDeclare: ['tiprack_offset_x', 'tuberack_offset_z'] },
	{ key: 'reagent', processType: 'reagent-filling', py: 'protocols/Reagent_Filling_GEN7.py', mustDeclare: ['tiprack_offset_x', 'tuberack_offset_z'] }
].filter((t) => !ONLY || t.key === ONLY);

async function main() {
	const uri = process.env.MONGODB_URI;
	if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	await mongoose.connect(uri);
	const db = mongoose.connection.db!;
	console.log(`[${MODE}] db=${db.databaseName}`);
	let pending = 0;
	for (const t of TARGETS) {
		const local = fs.readFileSync(t.py, 'utf8');
		const localHash = crypto.createHash('sha256').update(local).digest('hex');
		const missing = t.mustDeclare.filter((v) => !local.includes(`variable_name="${v}"`));
		if (missing.length) { console.error(`${t.py} does not declare ${missing.join(', ')} — refusing.`); process.exit(1); }
		const rows = await db.collection('opentrons_protocols').find({ processType: t.processType, isActive: true }).sort({ createdAt: -1 }).limit(1).toArray();
		const p = rows[0] as any;
		if (!p) { console.error(`No active ${t.processType} protocol row. Refusing.`); process.exit(1); }
		const storedHash = crypto.createHash('sha256').update(String(p.fileContent ?? '')).digest('hex');
		const same = storedHash === localHash;
		console.log(`${t.key.padEnd(8)} row ${p._id} ${p.fileName}  stored ${storedHash.slice(0, 12)}  local ${localHash.slice(0, 12)}  ${same ? '(already current)' : '(will refresh)'}`);
		console.log(`         deployments: ${(p.deployments ?? []).map((d: any) => `${d.robotName ?? d.robotId}:${String(d.opentronsProtocolId ?? '').slice(0, 8)}`).join(', ') || 'none'}`);
		if (same) continue;
		pending += 1;
		if (MODE === 'apply') {
			await db.collection('opentrons_protocols').updateOne({ _id: p._id }, { $set: { fileContent: local, fileHash: localHash, updatedAt: new Date() } });
			await db.collection('audit_log').insertOne({
				_id: generateId(), tableName: 'opentrons_protocols', recordId: String(p._id), action: 'protocol_source_refreshed',
				newData: { processType: t.processType, fileName: p.fileName, fromHash: storedHash, toHash: localHash, why: 'CALIB-5: per-robot rack offset RTPs (tiprack_offset_*/tuberack_offset_*), defaults 0' },
				changedAt: new Date(), changedBy: OPERATOR
			} as any);
			console.log(`         refreshed`);
		}
	}
	console.log(MODE === 'plan' ? `\nplan only: ${pending} row(s) would be refreshed. Re-run with --apply.` : `\nAPPLIED. Robots pick the new .py up at their next Sync / run-start re-upload.`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
