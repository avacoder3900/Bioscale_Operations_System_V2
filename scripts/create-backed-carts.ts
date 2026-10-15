/**
 * Create cartridge records straight at Backed (status 'backing'), on no bucket
 * (Jacob, 2026-10-05: carts that were physically on the line but never got a
 * record). Mirrors State Change's "No bucket → Backed" stamp
 * (bucket-service: backing.recordedAt / operator / manualBackedAt), which is
 * what wax filling's deck load and cancel path expect.
 *
 * No inventory is moved: these shells came out of the old stock that was
 * written off when the shell lots were reset (scripts/reset-shell-lots.ts).
 * Ids that already have a record are reported and never touched.
 * Dry-run by default; --apply to write.
 *
 *   npx tsx scripts/create-backed-carts.ts --ids <file> [--apply]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { readFileSync } from 'node:fs';
import { nanoid } from 'nanoid';
dotenv.config();

const APPLY = process.argv.includes('--apply');
const i = process.argv.indexOf('--ids');
const FILE = i > -1 ? process.argv[i + 1] : undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ACTOR = { _id: 'script', username: 'claude (req: alejandrov)' };

async function main() {
	if (!FILE) throw new Error('--ids <file> is required');
	const ids = [...new Set(readFileSync(FILE, 'utf8').split(/\r?\n/).map(l => l.trim().toLowerCase()).filter(Boolean))];
	const bad = ids.filter(x => !UUID.test(x));
	if (bad.length) throw new Error(`malformed ids: ${bad.join(', ')}`);
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	console.log(`db: ${db.databaseName}   ${new Date().toISOString()}   ${APPLY ? '*** APPLY ***' : '(dry run)'}   ${ids.length} id(s)`);
	const carts = db.collection('cartridge_records');

	const existing = new Map((await carts.find({ _id: { $in: ids } as any }, { projection: { status: 1 } }).toArray()).map((c: any) => [c._id, c.status]));
	// A cart id must not collide with a bucket sticker or an optical-test cartridge.
	const stickers = new Set((await db.collection('production_buckets').find({ $or: [{ _id: { $in: ids } as any }, { barcode: { $in: ids } }] }).toArray()).flatMap((b: any) => [b._id, b.barcode]));
	const optical = new Set((await db.collection('optical_test_cartridges').find({ _id: { $in: ids } as any }, { projection: { _id: 1 } }).toArray()).map((c: any) => c._id));
	// Were these ids ever printed? (any string field / array in a barcode sheet batch)
	const printed = new Set<string>();
	for (const b of await db.collection('barcode_sheet_batches').find({}).toArray() as any[]) {
		const s = JSON.stringify(b);
		for (const id of ids) if (s.includes(id)) printed.add(id);
	}
	const create: string[] = [];
	for (const id of ids) {
		const why = existing.has(id) ? `already exists (status ${existing.get(id)}) — skipped` : stickers.has(id) ? 'is a BUCKET sticker — skipped' : optical.has(id) ? 'is an optical-test cartridge — skipped' : null;
		if (!why) create.push(id);
		console.log(`  ${id}  ${why ?? 'create → backing'}   ${printed.has(id) ? 'printed label on file' : 'NOT in any barcode sheet batch'}`);
	}
	console.log(`\ncreate: ${create.length}   skipped: ${ids.length - create.length}`);
	if (!APPLY || !create.length) { console.log(APPLY ? 'Nothing to create.' : '\nDry run only — re-run with --apply to write.'); await mongoose.disconnect(); return; }

	const now = new Date();
	await carts.insertMany(create.map(id => ({
		_id: id as any,
		status: 'backing',
		statusUpdatedOn: now.toISOString(),
		backing: { cartridgeBlankLot: null, barcodeLabelLot: null, recordedAt: now, operator: ACTOR, manualBackedAt: now },
		used: false, usedForTestFill: false, validationErrors: [], reagentChain: [], photos: [], photoSequence: 0, corrections: [],
		notes: [{ _id: nanoid(), body: 'Created straight at Backed (no bucket): this cart was physically on the line with no record. Shell and label lots unknown; no inventory debited (old shell stock was written off 2026-10-05).', phase: 'bucket', author: ACTOR, createdAt: now }],
		createdAt: now, updatedAt: now
	})), { ordered: true });
	await db.collection('audit_log').insertMany(create.map(id => ({ _id: nanoid(), tableName: 'cartridge_records', recordId: id, action: 'INSERT', newData: { status: 'backing', noBucket: true }, reason: 'Cart on the line with no record — created straight at Backed at Jacob\'s request (2026-10-05)', changedAt: now, changedBy: ACTOR.username })));
	console.log(`APPLIED. created ${create.length} cart(s) at backing.  backing now: ${await carts.countDocuments({ status: 'backing' })}`);
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
