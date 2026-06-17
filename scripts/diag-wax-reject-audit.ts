/**
 * Audit recent wax runs to flag ones where rejections may have been silently
 * dropped by the opentron-control post-OT-2 QC page bug.
 *
 * Signals we can detect:
 *  - All cartridges Accepted, all with identical qcTimestamps (single-batch accept)
 *  - Zero scrapped/rejected cartridges
 *  - Multiple deckPositions — hard to believe every cartridge was perfect
 *
 * We can't prove "the user tried to reject" from DB alone — present the data
 * and let the operator cross-reference.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

const DAYS_BACK = 14;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;

	const since = new Date(Date.now() - DAYS_BACK * 24 * 60 * 60 * 1000);

	const runs = await db.collection('wax_filling_runs').find({
		createdAt: { $gte: since }
	}).sort({ createdAt: -1 }).toArray();

	console.log(`\nWax runs created in last ${DAYS_BACK} days: ${runs.length}\n`);
	console.log('Legend: BATCH=all accepts share one qcTimestamp (single completeQC click). REJ=rejected/scrapped count.\n');

	const header = 'createdAt'.padEnd(22) + '| runId'.padEnd(27) + '| status'.padEnd(15) + '| robot'.padEnd(12) + '| carts | acc | rej | batch | qc-operators';
	console.log(header);
	console.log('-'.repeat(header.length + 30));

	const suspicious: any[] = [];

	for (const r of runs as any[]) {
		const cartIds: string[] = r.cartridgeIds ?? [];
		const carts = cartIds.length
			? await db.collection('cartridge_records').find(
				{ _id: { $in: cartIds } },
				{ projection: { _id: 1, status: 1, waxQc: 1, 'waxFilling.deckPosition': 1 } }
			).toArray()
			: [];

		let acc = 0, rej = 0, pending = 0, other = 0;
		const acceptedTimestamps = new Set<number>();
		const qcOperators = new Set<string>();
		for (const c of carts as any[]) {
			const qc = c.waxQc?.status;
			if (qc === 'Accepted') {
				acc++;
				if (c.waxQc?.timestamp) acceptedTimestamps.add(new Date(c.waxQc.timestamp).getTime());
			} else if (qc === 'Rejected') {
				rej++;
			} else if (qc === 'Pending' || !qc) {
				pending++;
			} else {
				other++;
			}
			if (c.waxQc?.operator?.username) qcOperators.add(c.waxQc.operator.username);
		}

		const isBatch = acceptedTimestamps.size <= 1 && acc > 0;
		const created = new Date(r.createdAt).toISOString().slice(0, 19);
		const runId = String(r._id).slice(0, 24);
		const robot = (r.robot?.name ?? r.robot?._id ?? '?').toString().slice(0, 10);
		const status = (r.status ?? '?').toString().slice(0, 13);
		const ops = [...qcOperators].join(',') || '-';

		const line = `${created.padEnd(22)}| ${runId.padEnd(25)}| ${status.padEnd(13)}| ${robot.padEnd(10)}|  ${String(cartIds.length).padStart(3)}  | ${String(acc).padStart(3)} | ${String(rej).padStart(3)} |  ${isBatch ? 'yes' : 'no '}  | ${ops}`;

		// Flag if: accepted cartridges exist, zero rejections, single batch timestamp, cartridge count >= 4
		// These are candidates where an operator using the opentron-control post-OT-2 page
		// could have silently lost rejections.
		const flagged = acc >= 4 && rej === 0 && isBatch;
		console.log(`${flagged ? '>>' : '  '} ${line}`);
		if (flagged) suspicious.push({ runId: r._id, createdAt: r.createdAt, robot: r.robot?.name, carts: cartIds.length, acc, rej, qcOperators: [...qcOperators] });
	}

	console.log('\n--- Flagged runs (all-accepted, single-batch completeQC, ≥4 cartridges) ---');
	console.log('These are CANDIDATES — the DB shows no rejections, but if the operator');
	console.log('completed QC from the Opentron Control post-OT-2 queue, rejections would');
	console.log('have been silently dropped. Cross-reference with operator recall.\n');
	for (const s of suspicious) {
		console.log(`  ${s.runId}  created=${new Date(s.createdAt).toISOString()}  robot=${s.robot}  carts=${s.carts}  operators=${s.qcOperators.join(',')}`);
	}
	console.log(`\nTotal flagged: ${suspicious.length} of ${runs.length} runs in last ${DAYS_BACK} days`);

	// For comparison: runs where rejections DID persist (ruling out the bug being triggered)
	const withRejects = await db.collection('cartridge_records').aggregate([
		{ $match: { 'waxQc.status': 'Rejected', 'waxQc.timestamp': { $gte: since } } },
		{ $group: { _id: '$waxFilling.runId', n: { $sum: 1 }, firstTs: { $min: '$waxQc.timestamp' } } },
		{ $sort: { firstTs: -1 } }
	]).toArray();

	console.log('\n--- Runs where rejections DID persist (last N days) ---');
	if (withRejects.length === 0) {
		console.log('  (none)');
	} else {
		for (const w of withRejects as any[]) {
			console.log(`  run=${w._id}  rejectedCount=${w.n}  firstRejectAt=${new Date(w.firstTs).toISOString()}`);
		}
	}

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
