import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const d = await db.collection('manufacturing_settings').findOne({ _id: 'default' });
	console.log('manufacturing_settings.default =');
	console.log(JSON.stringify(d, null, 2));
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
