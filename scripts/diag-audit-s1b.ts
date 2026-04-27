import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const wax = await db.collection('cartridge_records').countDocuments({ 'waxStorage.locationId': { $exists: true, $ne: null } });
	const storage = await db.collection('cartridge_records').countDocuments({ 'storage.fridgeId': { $exists: true, $ne: null } });
	console.log('cartridges with waxStorage.locationId:', wax);
	console.log('cartridges with storage.fridgeId:', storage);
	await mongoose.disconnect();
}
main();
