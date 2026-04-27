import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const configs = await db.collection('sensor_configs').find({}).toArray();
	console.log(`SensorConfigs total: ${configs.length}\n`);
	for (const c of configs as any[]) {
		const linked = c.linkedEquipmentId ? await db.collection('equipment').findOne({ _id: c.linkedEquipmentId }) : null;
		console.log(`  ${c._id} (${c.thingName ?? c.deviceName ?? '?'})  linked=${linked?.name ?? c.linkedEquipmentId ?? '-'}  type=${linked?.equipmentType ?? c.linkedEquipmentType ?? '-'}`);
		console.log(`    temperatureMinC=${c.temperatureMinC ?? '(unset)'}  temperatureMaxC=${c.temperatureMaxC ?? '(unset)'}  alertsEnabled=${c.alertsEnabled}`);
	}
	await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
