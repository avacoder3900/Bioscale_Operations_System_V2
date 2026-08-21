/**
 * Read-only DB-wide hunt: list every collection, then scan any collection
 * plausibly related to validation/devices (or small enough to brute-force)
 * for references to device BT-M01-0000-0245.
 *
 * Identifiers: UDI BT-M01-0000-0245, SPU _id BsRzjSDa-ZH-h3Vn_r40V,
 * particle device 0a10aced202194944a07117c.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UDI = 'BT-M01-0000-0245';
const SPU_ID = 'BsRzjSDa-ZH-h3Vn_r40V';
const PARTICLE = '0a10aced202194944a07117c';
const NEEDLES = [UDI, SPU_ID, PARTICLE];

const NAME_HINT = /valid|mag|device|particle|barcode|integration|calib|sensor|test/i;
const BRUTE_FORCE_MAX = 5000; // full-scan cap per collection

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const infos = await db.listCollections().toArray();
	const names = infos.map((c) => c.name).sort();

	console.log('='.repeat(72));
	console.log(` ALL COLLECTIONS (${names.length})`);
	console.log('='.repeat(72));
	const counts: Record<string, number> = {};
	for (const n of names) {
		counts[n] = await db.collection(n).estimatedDocumentCount();
		const hinted = NAME_HINT.test(n) ? '  <-- name hint' : '';
		console.log(`  ${n.padEnd(40)} ${String(counts[n]).padStart(8)}${hinted}`);
	}

	console.log('\n' + '='.repeat(72));
	console.log(' SCANNING for device identifiers');
	console.log('='.repeat(72));

	for (const n of names) {
		const count = counts[n];
		const hinted = NAME_HINT.test(n);
		if (n === 'spus') continue; // already inspected directly

		if (!hinted && count > BRUTE_FORCE_MAX) {
			// Big non-hinted collection: targeted field queries only
			const hits = await db.collection(n).find({
				$or: [
					{ spuId: SPU_ID }, { spuUdi: UDI }, { udi: UDI },
					{ particleDeviceId: PARTICLE }, { deviceId: PARTICLE },
					{ recordId: SPU_ID }, { serialNumber: UDI }, { barcode: UDI }
				]
			}).limit(20).toArray();
			if (hits.length) {
				console.log(`\n  [${n}] targeted-field hits: ${hits.length}`);
				for (const h of hits as any[]) console.log(`    ${JSON.stringify(h).slice(0, 300)}`);
			}
			continue;
		}

		// Hinted or small: brute-force JSON scan
		const docs = await db.collection(n).find({}).limit(BRUTE_FORCE_MAX).toArray();
		const hits = docs.filter((d) => {
			const j = JSON.stringify(d);
			return NEEDLES.some((needle) => j.includes(needle));
		});
		if (hits.length) {
			console.log(`\n  [${n}] brute-force hits: ${hits.length}${count > BRUTE_FORCE_MAX ? ` (scanned first ${BRUTE_FORCE_MAX} of ${count})` : ''}`);
			for (const h of hits.slice(0, 10) as any[]) {
				console.log(`    ${JSON.stringify(h).slice(0, 400)}`);
			}
			if (hits.length > 10) console.log(`    ... and ${hits.length - 10} more`);
		}
		if (count > BRUTE_FORCE_MAX) {
			console.log(`  [${n}] NOTE: only first ${BRUTE_FORCE_MAX} of ${count} docs brute-force scanned`);
		}
	}

	console.log('\nScan complete.');
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
