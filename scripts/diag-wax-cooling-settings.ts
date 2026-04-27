import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI!;

async function main() {
	await mongoose.connect(URI);
	const db = mongoose.connection.db!;
	const s = await db.collection('manufacturing_settings').findOne({ _id: 'default' as any });
	console.log('ManufacturingSettings.waxFilling:');
	console.log(JSON.stringify((s as any)?.waxFilling ?? {}, null, 2));
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
