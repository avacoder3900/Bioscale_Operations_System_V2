/**
 * Restore a cartridge deck's wells to a known-good bundled geometry (the deck
 * definition as it was uploaded with a protocol that completed a run), with a
 * per-well guard: every well must currently equal baseline + the expected net
 * delta of the edits being undone, or the script refuses.
 *
 * 2026-10-26: gen4deck_gen7cartridge_004 after three Studio edits (−3/0/+2 ×2,
 * +3/−1/−3) had 12 A-row wax holes at y = −0.5; the robot rejected the bundle
 * ("could not be read as a labware definition"), so no run could start on B07.
 *
 *   MONGODB_URI=... npx tsx scripts/restore-deck-geometry.ts --deck gen4deck_gen7cartridge_004 \
 *     --baseline <defs.json from a protocol analysis> --expect-delta=-3,-1,1 [--apply]
 */
import fs from 'node:fs';
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
import { generateId } from '../src/lib/server/db/utils.js';

const argv = process.argv.slice(2);
const arg = (n: string) => { const i = argv.indexOf('--' + n); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
const MODE: 'plan' | 'apply' = argv.includes('--apply') ? 'apply' : 'plan';
const deck = arg('deck'); const baselinePath = arg('baseline');
const ed = (argv.find((a) => a.startsWith('--expect-delta=')) ?? '').split('=')[1];
if (!deck || !baselinePath || !ed) { console.error('usage: --deck <loadName> --baseline <defs.json> --expect-delta=dx,dy,dz [--apply]'); process.exit(1); }
const [edx, edy, edz] = ed.split(',').map(Number);
const OPERATOR = 'claude-code';
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

async function main() {
	const uri = process.env.MONGODB_URI; if (!uri) { console.error('MONGODB_URI is not set.'); process.exit(1); }
	const base = JSON.parse(fs.readFileSync(baselinePath, 'utf8'))[deck!];
	if (!base?.wells) { console.error(`baseline has no ${deck}`); process.exit(1); }
	await mongoose.connect(uri); const db = mongoose.connection.db!;
	console.log(`[${MODE}] db=${db.databaseName}`);
	const docs = await db.collection('labware_definitions').find({ loadName: deck }).toArray();
	if (docs.length !== 1) { console.error(`Expected 1 definition for ${deck}, found ${docs.length}`); process.exit(1); }
	const def = docs[0] as any; const wells = def.definition?.wells ?? {};
	const names = Object.keys(wells);
	const neg = names.filter((w) => wells[w].x < 0 || wells[w].y < 0 || wells[w].z < 0);
	console.log(`${deck} v${def.version}: ${names.length} wells; ${neg.length} with a negative coordinate now: ${neg.slice(0, 14).map((w) => `${w}(${wells[w].x},${wells[w].y},${wells[w].z})`).join(' ')}`);
	const problems: string[] = []; const setOps: Record<string, number> = {}; const history: any[] = []; const now = new Date();
	let already = 0;
	for (const w of names) {
		const b = base.wells[w]; const c = wells[w];
		if (!b) { problems.push(`${w}: not in baseline`); continue; }
		if (near(c.x, b.x) && near(c.y, b.y) && near(c.z, b.z)) { already++; continue; }
		if (!near(c.x, b.x + edx) || !near(c.y, b.y + edy) || !near(c.z, b.z + edz)) { problems.push(`${w}: current (${c.x},${c.y},${c.z}) != baseline (${b.x},${b.y},${b.z}) + (${edx},${edy},${edz})`); continue; }
		setOps[`definition.wells.${w}.x`] = b.x; setOps[`definition.wells.${w}.y`] = b.y; setOps[`definition.wells.${w}.z`] = b.z;
		history.push({ _id: generateId(), deckLoadName: deck, deckEquipmentId: null, wellName: w, delta: { x: -edx, y: -edy, z: -edz }, before: { x: c.x, y: c.y, z: c.z }, after: { x: b.x, y: b.y, z: b.z }, robotId: null, createdBy: OPERATOR, createdAt: now });
	}
	console.log(`guard: ${history.length} wells restore by (${-edx},${-edy},${-edz}); ${already} already at baseline; ${problems.length} problems`);
	for (const p of problems.slice(0, 10)) console.error('  ' + p);
	if (problems.length) { await mongoose.disconnect(); process.exit(1); }
	console.log(`A1: (${wells.A1.x},${wells.A1.y},${wells.A1.z}) -> (${base.wells.A1.x},${base.wells.A1.y},${base.wells.A1.z}); A2: (${wells.A2.x},${wells.A2.y},${wells.A2.z}) -> (${base.wells.A2.x},${base.wells.A2.y},${base.wells.A2.z})`);
	if (MODE === 'plan' || !history.length) { console.log(history.length ? 'plan only. Re-run with --apply.' : 'nothing to do'); await mongoose.disconnect(); return; }
	await db.collection('labware_definitions').updateOne({ _id: def._id }, { $set: { ...setOps, hasUnpublishedEdits: true } });
	await db.collection('deck_calibration_edits').insertMany(history);
	await db.collection('audit_log').insertOne({ _id: generateId(), tableName: 'labware_definitions', recordId: deck, action: 'deck_calibration_edit_batch', newData: { delta: { x: -edx, y: -edy, z: -edz }, wellCount: history.length, wells: history.map((h) => h.wellName), robotId: null, note: `restore to the geometry bundled in the last protocol that completed a run; undoes today's net (${edx},${edy},${edz}) which left ${neg.length} wells with negative coordinates (robot rejected the labware definition)` }, changedAt: now, changedBy: OPERATOR } as any);
	const chk = (await db.collection('labware_definitions').findOne({ _id: def._id })) as any;
	const stillNeg = Object.entries(chk.definition.wells).filter(([, v]: any) => v.x < 0 || v.y < 0 || v.z < 0).length;
	console.log(`APPLIED. A1 now (${chk.definition.wells.A1.x},${chk.definition.wells.A1.y},${chk.definition.wells.A1.z}); negative-coordinate wells: ${stillNeg}`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error('FAILED:', e); process.exit(1); });
