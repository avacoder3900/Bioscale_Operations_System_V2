/**
 * READ-ONLY diag #3 for the "ghost cartridge" bug (2026-08-05).
 *
 * Focus: WHERE do the test output rows (arms A/B/C, readings 2010/2452/2126,
 * 2026-08-05T17:47:05.986Z, device 0a10aced202194944a0520b4) live, and do they
 * belong to the 8/5 run or the 8/4 run?
 *
 *  - cartridge doc: all fields EXCEPT assay/photos/notes (test data, rawData,
 *    checkpoints, device, testResult...)
 *  - grep doc JSON for the reported readings
 *  - both experiments' worksheets for the UUID / readings
 *  - full audit entries for the two link events + the 8/4 link
 *
 * Run: npx tsx scripts/diag-cartridge-ghost-testdata.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UUID = 'b1c66134-a875-432f-a957-beefbe32a582';
const READINGS = ['2010', '2452', '2126'];
const hr = (t: string) => console.log('\n' + '='.repeat(76) + `\n ${t}\n` + '='.repeat(76));

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	hr('A. cartridge doc: everything except assay/photos/notes');
	const cart: any = await db.collection('cartridge_records').findOne({ _id: UUID as any });
	const { assay, photos, notes, ...rest } = cart;
	console.log('top-level keys:', Object.keys(cart).join(', '));
	console.log(JSON.stringify(rest, null, 1).slice(0, 20000));

	hr('B. reading-value grep inside the cartridge doc');
	const full = JSON.stringify(cart);
	for (const r of READINGS) {
		let idx = full.indexOf(r);
		const spots: string[] = [];
		while (idx !== -1 && spots.length < 5) {
			spots.push(full.slice(Math.max(0, idx - 120), idx + 60).replace(/\s+/g, ' '));
			idx = full.indexOf(r, idx + 1);
		}
		console.log(`\n"${r}" occurrences (${spots.length} shown):`);
		for (const s of spots) console.log('  ...' + s + '...');
	}

	hr('C. experiments: worksheets + rows mentioning the UUID or readings');
	const exps = await db.collection('experiments').find({ 'arms.cartridges.barcode': UUID }).toArray();
	for (const e of exps as any[]) {
		console.log(`\n--- experiment ${e._id} "${e.name}"`);
		const ws = e.worksheets;
		console.log('worksheets type:', Array.isArray(ws) ? `array[${ws.length}]` : typeof ws);
		const wsJson = JSON.stringify(ws ?? null);
		console.log('worksheets JSON length:', wsJson.length);
		console.log('worksheets contains UUID:', wsJson.includes(UUID));
		for (const r of READINGS) console.log(`worksheets contains "${r}":`, wsJson.includes(r));
		if (Array.isArray(ws)) {
			for (const [wi, w] of ws.entries()) {
				const wj = JSON.stringify(w);
				if (wj.includes(UUID) || READINGS.some((r) => wj.includes(r))) {
					console.log(`\n worksheet[${wi}] keys: ${Object.keys(w).join(', ')}`);
					console.log(wj.slice(0, 8000));
				}
			}
		} else if (ws && wsJson.includes(UUID)) {
			console.log(wsJson.slice(0, 8000));
		}
	}

	hr('D. full audit entries for the link/re-link events');
	const ids = ['oJvuIPWisqbMx37MQOXHn', '7BA238XzarHGLN-o6Eo8r', '714MgvWm4l0382QQbVXLi'];
	for (const id of ids) {
		const doc = await db.collection('audit_log').findOne({ _id: id as any });
		console.log(`\n--- audit ${id}`);
		console.log(JSON.stringify(doc, null, 1).slice(0, 5000));
	}

	hr('E. all audit_log entries for the cartridge, sorted by changedAt');
	const audits = await db.collection('audit_log')
		.find({ recordId: UUID })
		.sort({ changedAt: 1 })
		.toArray();
	for (const a of audits as any[]) {
		console.log(`  ${a.changedAt ?? '(no changedAt)'}  action=${a.action}  by=${a.changedBy ?? ''}  new=${JSON.stringify(a.newData ?? {}).slice(0, 220)}`);
	}

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
