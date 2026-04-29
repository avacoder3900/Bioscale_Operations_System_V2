import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
const URI = process.env.MONGODB_URI;
if (!URI) { console.error('MONGODB_URI missing'); process.exit(1); }

async function main() {
	await mongoose.connect(URI!);
	const db = mongoose.connection.db!;

	const settings: any = await db.collection('manufacturingsettings').findOne({ _id: 'default' as any });
	console.log('=== ManufacturingSettings.waxFilling ===');
	console.log(JSON.stringify(settings?.waxFilling ?? null, null, 2));
	console.log(`\nminCoolingBeforeQcMin: ${settings?.waxFilling?.minCoolingBeforeQcMin ?? 'NOT SET (uses code default)'}`);

	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
