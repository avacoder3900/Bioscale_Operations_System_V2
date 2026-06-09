import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const u = await db.collection('users').findOne({ email: 'jacobq@brevitest.com' });
	if (u) {
		console.log(JSON.stringify({ _id: u._id, username: (u as any).username, email: (u as any).email, role: (u as any).role }, null, 2));
	} else {
		console.log('no match on jacobq@brevitest.com');
		const users = await db.collection('users').find({}).project({ _id: 1, username: 1, email: 1 }).limit(20).toArray();
		console.log('First 20 users:');
		for (const x of users as any[]) console.log(`  ${x._id}  ${x.username}  ${x.email}`);
	}
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
