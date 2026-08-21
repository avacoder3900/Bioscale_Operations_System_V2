/**
 * READ-ONLY diag #4 for the "ghost cartridge" bug (2026-08-05).
 *
 * - cartridge.analysis subdoc: structure + any timestamps (skip bulky rows)
 * - rawData summary: assayId, startTime, duration, first/last reading msec
 * - webhook_logs mentioning the UUID (both 8/4 and 8/5 upload-test payloads —
 *   is the 8/4 ghost data still recoverable there?)
 *
 * Run: npx tsx scripts/diag-cartridge-ghost-analysis.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const UUID = 'b1c66134-a875-432f-a957-beefbe32a582';
const hr = (t: string) => console.log('\n' + '='.repeat(76) + `\n ${t}\n` + '='.repeat(76));

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const cart: any = await db.collection('cartridge_records').findOne({ _id: UUID as any });

	hr('rawData summary');
	const rd = cart.rawData ?? {};
	console.log('assayId:', rd.assayId, ' startTime:', rd.startTime, ' duration:', rd.duration);
	console.log('numberOfReadings:', rd.numberOfReadings, ' actual readings len:', rd.readings?.length);
	if (rd.readings?.length) {
		console.log('first reading msec:', rd.readings[0].msec, ' last:', rd.readings[rd.readings.length - 1].msec);
	}

	hr('analysis subdoc structure');
	const an = cart.analysis;
	if (!an) { console.log('no analysis field'); }
	else {
		console.log('type:', Array.isArray(an) ? `array[${an.length}]` : typeof an);
		const scrub = (o: any, depth = 0): any => {
			if (o == null || typeof o !== 'object') return o;
			if (Array.isArray(o)) return o.length > 6 ? [`<array of ${o.length}>`, ...o.slice(0, 2).map((x) => scrub(x, depth + 1))] : o.map((x) => scrub(x, depth + 1));
			const out: any = {};
			for (const [k, v] of Object.entries(o)) out[k] = scrub(v, depth + 1);
			return out;
		};
		console.log(JSON.stringify(scrub(an), null, 1).slice(0, 8000));
		const s = JSON.stringify(an);
		// any ISO timestamps inside analysis?
		const dates = [...new Set(s.match(/20\d\d-\d\d-\d\dT[\d:.]+Z/g) ?? [])];
		console.log('ISO timestamps found inside analysis:', dates.join(', ') || '(none)');
	}

	hr('webhook_logs mentioning the UUID');
	const cur = db.collection('webhook_logs').find({}).sort({ _id: 1 });
	let n = 0;
	for await (const d of cur) {
		const s = JSON.stringify(d);
		if (s.includes(UUID)) {
			n++;
			const dd: any = d;
			console.log(`\n--- webhook _id=${dd._id} receivedAt=${dd.receivedAt ?? dd.createdAt ?? dd.timestamp ?? ''} event=${dd.event ?? dd.type ?? dd.name ?? ''} device=${dd.deviceId ?? dd.coreid ?? ''}`);
			console.log(s.slice(0, 1200));
		}
	}
	console.log('\nwebhook_logs hits:', n);

	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
