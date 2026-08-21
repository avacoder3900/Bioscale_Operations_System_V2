/**
 * READ-ONLY diag #1 for the "ghost cartridge" bug (Jacob, 2026-08-05).
 *
 * Cartridge UUID: b1c66134-a875-432f-a957-beefbe32a582
 * Barcode:        A6B051EB-40648864473-014
 * Device:         0a10aced202194944a0520b4
 *
 * Lists every collection, then hunts each one for any of the identifiers
 * (targeted field queries on big collections, brute-force JSON scan on
 * hinted/small ones). Prints doc ids + trimmed JSON for every hit.
 *
 * Run: npx tsx scripts/diag-cartridge-ghost-scan.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UUID = 'b1c66134-a875-432f-a957-beefbe32a582';
const BARCODE = 'A6B051EB-40648864473-014';
const DEVICE = '0a10aced202194944a0520b4';
const NEEDLES = [UUID, BARCODE, DEVICE, UUID.toUpperCase(), BARCODE.toLowerCase()];

const NAME_HINT = /cartridge|cv|image|test|analys|analyz|run|result|assay|sample|device|audit|link|photo|capture/i;
const BRUTE_FORCE_MAX = 8000;

function hitFields(doc: any, needles: string[]): string[] {
	// Walk the doc and report which paths contain a needle.
	const out: string[] = [];
	const walk = (v: any, path: string) => {
		if (v == null) return;
		if (typeof v === 'string') {
			for (const n of needles) {
				if (v.includes(n)) { out.push(`${path}~"${n.slice(0, 12)}..."`); return; }
			}
		} else if (Array.isArray(v)) {
			v.forEach((x, i) => walk(x, `${path}[${i}]`));
		} else if (typeof v === 'object' && !(v instanceof Date)) {
			for (const [k, x] of Object.entries(v)) walk(x, path ? `${path}.${k}` : k);
		}
	};
	walk(doc, '');
	return [...new Set(out)];
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const infos = await db.listCollections().toArray();
	const names = infos.map((c) => c.name).sort();

	console.log('='.repeat(76));
	console.log(` ALL COLLECTIONS (${names.length})`);
	console.log('='.repeat(76));
	const counts: Record<string, number> = {};
	for (const n of names) {
		counts[n] = await db.collection(n).estimatedDocumentCount();
		console.log(`  ${n.padEnd(44)} ${String(counts[n]).padStart(8)}${NAME_HINT.test(n) ? '  <-- hint' : ''}`);
	}

	console.log('\n' + '='.repeat(76));
	console.log(' HUNTING for UUID / barcode / device');
	console.log('='.repeat(76));

	for (const n of names) {
		const count = counts[n];
		const hinted = NAME_HINT.test(n);

		if (!hinted && count > BRUTE_FORCE_MAX) {
			const hits = await db.collection(n).find({
				$or: [
					{ _id: UUID as any }, { _id: BARCODE as any },
					{ barcode: { $in: [BARCODE, UUID] } },
					{ cartridgeId: { $in: [UUID, BARCODE] } },
					{ cartridge_id: { $in: [UUID, BARCODE] } },
					{ cartridgeRecordId: { $in: [UUID, BARCODE] } },
					{ 'cartridgeTag.cartridgeRecordId': { $in: [UUID, BARCODE] } },
					{ deviceId: DEVICE }, { device_id: DEVICE }, { particleDeviceId: DEVICE },
					{ serialNumber: { $in: [BARCODE, UUID] } }
				]
			}).limit(25).toArray();
			if (hits.length) {
				console.log(`\n[${n}] targeted-field hits: ${hits.length}`);
				for (const h of hits as any[]) {
					console.log(`  _id=${h._id}  fields=${hitFields(h, NEEDLES).join(', ')}`);
					console.log(`    ${JSON.stringify(h).slice(0, 400)}`);
				}
			}
			continue;
		}

		const docs = await db.collection(n).find({}).limit(BRUTE_FORCE_MAX).toArray();
		const hits = docs.filter((d) => {
			const j = JSON.stringify(d);
			return NEEDLES.some((needle) => j.includes(needle));
		});
		if (hits.length) {
			console.log(`\n[${n}] brute-force hits: ${hits.length}${count > BRUTE_FORCE_MAX ? ` (first ${BRUTE_FORCE_MAX} of ${count} scanned)` : ''}`);
			for (const h of hits.slice(0, 15) as any[]) {
				console.log(`  _id=${h._id}  fields=${hitFields(h, NEEDLES).join(', ')}`);
			}
			if (hits.length > 15) console.log(`  ... and ${hits.length - 15} more`);
		}
		if (count > BRUTE_FORCE_MAX) {
			console.log(`[${n}] NOTE: only first ${BRUTE_FORCE_MAX} of ${count} docs brute-force scanned`);
		}
	}

	console.log('\nScan complete.');
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
