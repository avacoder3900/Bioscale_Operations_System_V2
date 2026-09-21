/**
 * READ-ONLY diag #2 for the "ghost cartridge" bug (2026-08-05).
 *
 * Deep-dives every hit from diag-cartridge-ghost-scan.ts:
 *  - cartridge_records doc for the UUID (full dump: photos[], testExecution, barcode fields)
 *  - barcode hunt (full-field + regex on serial fragment) across cartridge_records
 *  - the 2 cv_images + 4 cv_inspections
 *  - the 2 experiments referencing the cartridge (arms/readings/timestamps)
 *  - research 'logs' collection: data.cartridgeId = UUID + device activity 8/3-8/6
 *  - audit_log full cursor scan for UUID/barcode
 *  - opentrons_scanner_sweep_runs + reagent_batch_records entries
 *  - OTHER DATABASES on the shared cluster: listDatabases, then hunt research
 *    collections for the UUID / barcode / test docs.
 *
 * Run: npx tsx scripts/diag-cartridge-ghost-deepdive.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UUID = 'b1c66134-a875-432f-a957-beefbe32a582';
const BARCODE = 'A6B051EB-40648864473-014';
const SERIAL_FRAG = '40648864473';
const DEVICE = '0a10aced202194944a0520b4';

const hr = (t: string) => console.log('\n' + '='.repeat(76) + `\n ${t}\n` + '='.repeat(76));
const j = (o: any, max = 6000) => console.log(JSON.stringify(o, null, 1).slice(0, max));

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	hr('1. cartridge_records: the UUID doc (full)');
	const cart = await db.collection('cartridge_records').findOne({ _id: UUID as any });
	if (cart) j(cart, 12000); else console.log('NOT FOUND by _id');

	hr('2. cartridge_records: barcode hunt (exact + serial fragment regex)');
	const bcHits = await db.collection('cartridge_records').find({
		$or: [
			{ barcode: BARCODE }, { serialNumber: BARCODE }, { label: BARCODE },
			{ barcode: { $regex: SERIAL_FRAG } },
			{ 'testExecution.barcode': { $regex: SERIAL_FRAG } }
		]
	}).limit(10).toArray();
	console.log('hits:', bcHits.length);
	for (const h of bcHits) j(h, 3000);

	hr('3. cv_images linked to the UUID');
	const imgs = await db.collection('cv_images')
		.find({ 'cartridgeTag.cartridgeRecordId': UUID })
		.project({ _id: 1, capturedAt: 1, createdAt: 1, cartridgeImageNumber: 1, cartridgeTag: 1, filePath: 1, imageUrl: 1, stationId: 1, source: 1, uploadedBy: 1, qcLabel: 1 })
		.toArray();
	for (const i of imgs) j(i, 2500);

	hr('4. cv_inspections for the UUID');
	const insp = await db.collection('cv_inspections').find({ cartridgeRecordId: UUID }).toArray();
	for (const i of insp) j(i, 2500);

	hr('5. experiments referencing the cartridge');
	const exps = await db.collection('experiments').find({
		$or: [{ 'arms.cartridges.barcode': UUID }, { 'arms.cartridges.barcode': BARCODE }]
	}).toArray();
	console.log('experiment count:', exps.length);
	for (const e of exps as any[]) {
		console.log(`\n--- experiment _id=${e._id} name="${e.name}" status=${e.status}`);
		console.log(`  createdAt=${e.createdAt?.toISOString?.() ?? e.createdAt} updatedAt=${e.updatedAt?.toISOString?.() ?? e.updatedAt}`);
		console.log(`  keys: ${Object.keys(e).join(', ')}`);
		for (const arm of e.arms ?? []) {
			console.log(`  arm "${arm.name ?? arm.label ?? arm._id}" cartridges=${arm.cartridges?.length}`);
			for (const c of arm.cartridges ?? []) {
				const isTarget = c.barcode === UUID || c.barcode === BARCODE;
				console.log(`   ${isTarget ? '>>> ' : '    '}${JSON.stringify(c).slice(0, 500)}`);
			}
		}
	}

	hr('6. research "logs": entries for the cartridge UUID');
	const cartLogs = await db.collection('logs').find({
		$or: [{ 'data.cartridgeId': UUID }, { 'data.barcode': BARCODE }]
	}).sort({ loggedOn: 1 }).toArray();
	console.log('hits:', cartLogs.length);
	for (const l of cartLogs) j(l, 1500);

	hr('7. research "logs": device activity 2026-08-03 .. 2026-08-06');
	const devLogs = await db.collection('logs').find({
		deviceId: DEVICE,
		loggedOn: { $gte: '2026-08-03T00:00:00.000Z', $lte: '2026-08-06T23:59:59.999Z' }
	}).sort({ loggedOn: 1 }).toArray();
	console.log('hits:', devLogs.length);
	for (const l of devLogs as any[]) {
		console.log(`  ${l.loggedOn}  type=${l.type} status=${l.status} cartridgeId=${l.data?.cartridgeId ?? ''} ${l.type === 'upload-test' ? JSON.stringify(l.data).slice(0, 200) : ''}`);
	}

	hr('8. audit_log full cursor scan for UUID/barcode');
	const cursor = db.collection('audit_log').find({}).project({});
	let audHits = 0;
	for await (const d of cursor) {
		const s = JSON.stringify(d);
		if (s.includes(UUID) || s.includes(BARCODE) || s.includes(SERIAL_FRAG)) {
			audHits++;
			console.log(`  ${JSON.stringify(d).slice(0, 600)}`);
		}
	}
	console.log('audit_log hits:', audHits);
	// also audit_logs (plural variant)
	const aud2 = await db.collection('audit_logs').find({}).toArray();
	const aud2hits = aud2.filter((d) => { const s = JSON.stringify(d); return s.includes(UUID) || s.includes(BARCODE); });
	console.log('audit_logs (variant) hits:', aud2hits.length);
	for (const h of aud2hits) j(h, 800);

	hr('9. scanner sweeps + reagent fill entries for the UUID');
	const sweeps = await db.collection('opentrons_scanner_sweep_runs').find({ 'scans.barcode': UUID }).toArray();
	for (const s of sweeps as any[]) {
		const scan = (s.scans ?? []).filter((x: any) => x.barcode === UUID);
		console.log(`  sweep _id=${s._id} startedAt=${s.startedAt?.toISOString?.() ?? s.startedAt} run=${s.label ?? s.name ?? ''}`);
		for (const x of scan) console.log(`    ${JSON.stringify(x).slice(0, 300)}`);
	}
	const rbr = await db.collection('reagent_batch_records').find({ 'cartridgesFilled.cartridgeId': UUID }).toArray();
	for (const r of rbr as any[]) {
		const mine = (r.cartridgesFilled ?? []).filter((x: any) => x.cartridgeId === UUID);
		console.log(`  reagent_batch _id=${r._id} batchNumber=${r.batchNumber ?? ''} reagent=${r.reagentName ?? r.reagentType ?? ''}`);
		for (const x of mine) console.log(`    ${JSON.stringify(x).slice(0, 300)}`);
	}

	hr('10. OTHER DATABASES on the cluster');
	const admin = db.admin();
	let dbNames: string[] = [];
	try {
		const res = await admin.listDatabases();
		dbNames = res.databases.map((d: any) => d.name);
		console.log('databases:', dbNames.join(', '));
	} catch (e: any) {
		console.log('listDatabases failed:', e.message);
	}
	const currentName = db.databaseName;
	console.log('current db:', currentName);
	for (const name of dbNames) {
		if (name === currentName || name === 'admin' || name === 'local' || name === 'config') continue;
		const other = mongoose.connection.getClient().db(name);
		const colls = (await other.listCollections().toArray()).map((c) => c.name).sort();
		console.log(`\n--- DB "${name}" collections (${colls.length}): ${colls.join(', ')}`);
		for (const cn of colls) {
			const coll = other.collection(cn);
			const count = await coll.estimatedDocumentCount();
			// targeted first
			const targeted = await coll.find({
				$or: [
					{ _id: UUID as any }, { _id: BARCODE as any },
					{ cartridgeId: UUID }, { 'data.cartridgeId': UUID },
					{ barcode: { $in: [BARCODE, UUID] } }, { label: BARCODE },
					{ deviceId: DEVICE }, { device_id: DEVICE }
				]
			}).limit(15).toArray().catch(() => [] as any[]);
			let hits = targeted;
			if (!hits.length && count <= 8000) {
				const docs = await coll.find({}).limit(8000).toArray().catch(() => [] as any[]);
				hits = docs.filter((d) => { const s = JSON.stringify(d); return s.includes(UUID) || s.includes(BARCODE) || s.includes(SERIAL_FRAG); });
			}
			if (hits.length) {
				console.log(`  [${name}.${cn}] hits: ${hits.length} (count=${count})`);
				for (const h of hits.slice(0, 8)) console.log(`    ${JSON.stringify(h).slice(0, 700)}`);
			}
		}
	}

	console.log('\nDeep-dive complete.');
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
