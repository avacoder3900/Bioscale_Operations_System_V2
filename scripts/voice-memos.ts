/**
 * VOICE-01 operator script.
 *
 *   npx tsx scripts/voice-memos.ts captures [n]   Print the last n (default 5) raw webhook bodies
 *                                                 from voice_memo_captures (written only while
 *                                                 VOICENOTES_CAPTURE_RAW=true). Read-only.
 *   npx tsx scripts/voice-memos.ts memos [n]      Print the last n stored memos (no raw). Read-only.
 *   npx tsx scripts/voice-memos.ts indexes        Create the voice-memo indexes (idempotent). Needed
 *                                                 once autoIndex is off (PERF-01 BM-05); harmless before.
 *   npx tsx scripts/voice-memos.ts key            Print a fresh random webhook secret.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { randomBytes } from 'node:crypto';
dotenv.config();

const [cmd = 'captures', nArg] = process.argv.slice(2);
const n = Math.max(1, parseInt(nArg ?? '5') || 5);

async function main() {
	if (cmd === 'key') {
		console.log(randomBytes(24).toString('base64url'));
		return;
	}

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	if (cmd === 'captures') {
		const rows = await db.collection('voice_memo_captures').find().sort({ receivedAt: -1 }).limit(n).toArray();
		if (!rows.length) console.log('No captures. Is VOICENOTES_CAPTURE_RAW=true set on the deployment?');
		for (const r of rows.reverse()) {
			console.log(`=== ${r.receivedAt?.toISOString?.()}  speaker=${r.speaker}  event=${r.event || '(none)'}  outcome=${r.outcome}`);
			console.log(JSON.stringify(r.body, null, 2));
		}
	} else if (cmd === 'memos') {
		const rows = await db
			.collection('voice_memos')
			.find({}, { projection: { raw: 0 } })
			.sort({ receivedAt: -1 })
			.limit(n)
			.toArray();
		if (!rows.length) console.log('No memos stored yet.');
		for (const m of rows.reverse()) {
			console.log(
				`=== ${m._id}  ${m.recordedAt?.toISOString?.()}  ${m.speaker?.username}  kind=${m.kind}` +
					`${m.experimentRef ? ` exp=${m.experimentRef}` : ''}  matchedBy=${m.matchedBy}  tags=[${(m.tags ?? []).join(', ')}]` +
					`  processed=${m.processed}  revisions=${m.revisions?.length ?? 0}`
			);
			console.log(`    title: ${m.title}`);
			console.log(`    ${String(m.transcript ?? '').slice(0, 400)}`);
		}
	} else if (cmd === 'indexes') {
		const memos = db.collection('voice_memos');
		await memos.createIndex({ sourceNoteId: 1 }, { unique: true });
		await memos.createIndex({ processed: 1, recordedAt: -1 });
		await memos.createIndex({ 'speaker.username': 1, recordedAt: -1 });
		await memos.createIndex({ tags: 1 });
		const digests = db.collection('voice_memo_digests');
		await digests.createIndex({ status: 1, date: -1 });
		await digests.createIndex({ memoIds: 1 });
		await db.collection('voice_memo_captures').createIndex({ receivedAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 14 });
		console.log('voice-memo indexes ensured.');
	} else {
		console.log(`Unknown command "${cmd}". Use captures | memos | indexes | key.`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
