import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();
(async () => {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	// Delete nanoid-shaped status='backing' stubs
	const res = await db.collection('cartridge_records').deleteMany({
		status: 'backing',
		_id: { $not: /^[0-9a-f-]{36}$/i }
	});
	console.log(`Deleted nanoid backing stubs: ${res.deletedCount}`);
	// Verify
	const remaining = await db.collection('cartridge_records').countDocuments({ status: 'backing' });
	console.log(`Remaining status=backing: ${remaining}`);
	await mongoose.disconnect();
})();
