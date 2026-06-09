import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const ids = [
		'56e22b9c-d5bd-4d7c-82cd-c002bb86f29b',
		'9d4d520b-6454-43cc-a8e6-681a4164560e',
		'af4cd787-aed5-4371-af41-85f93c6f97fb',
		'c95613a5-f267-4336-99df-39a6ac115216',
		'9a5aefe9-b4af-49e6-907b-f8fbb5dce2ab',
		'a87c7aa0-413d-4d40-91e1-06dad9b64295',
		'f7be9f9c-3371-4d65-b96d-a705d79ef05a',
		'decd0e58-5e06-43ae-a00e-831af583d612',
		'af717a43-b373-415a-8319-6c8c8c77265a',
		'f9a8d8b0-8d9e-4be0-aa51-8b9039c7800c',
		'095e1ce1-421b-4a6a-a7b6-28f3bf06043d',
		'8e8c7347-0feb-4654-ab18-921a898221e2',
		'78a723df-98c6-4d71-bbeb-c79d6b15c421',
		'6c7f15cb-3bd1-4314-a41b-aa05fd64f3d2'
	];
	const docs = await db.collection('cartridge_records').find({ _id: { $in: ids } as any }).toArray();
	for (const d of docs as any[]) {
		console.log('─'.repeat(60));
		console.log(`_id: ${d._id}`);
		console.log(`status: ${d.status}`);
		console.log(`createdAt: ${d.createdAt}`);
		console.log(`has backing: ${!!d.backing} (lotId=${d.backing?.lotId})`);
		console.log(`has waxFilling: ${!!d.waxFilling} (runId=${d.waxFilling?.runId})`);
		console.log(`has waxQc: ${!!d.waxQc} status=${d.waxQc?.status}`);
		console.log(`has reagentFilling: ${!!d.reagentFilling} (runId=${d.reagentFilling?.runId} isResearch=${d.reagentFilling?.isResearch} assayType=${JSON.stringify(d.reagentFilling?.assayType)})`);
		console.log(`has testing: ${!!d.testing} (testResultId=${d.testing?.testResultId})`);
		console.log(`finalizedAt: ${d.finalizedAt}`);
	}
	await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
