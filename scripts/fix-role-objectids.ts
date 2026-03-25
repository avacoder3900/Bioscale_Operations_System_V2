/**
 * Remove auto-generated ObjectId _id fields from user roles subdocuments.
 * Mongoose was adding these because the roles schema didn't have { _id: false }.
 * SvelteKit can't serialize ObjectId, causing 500 errors.
 *
 * Usage: npx tsx scripts/fix-role-objectids.ts
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const users = db.collection('users');

	// Find all users where any role subdocument has an ObjectId _id
	const affected = await users.find({ 'roles._id': { $exists: true } }).toArray();
	console.log(`Found ${affected.length} users with ObjectId _id on roles subdocuments`);

	for (const user of affected) {
		const cleaned = (user.roles || []).map((r: any) => {
			const { _id, ...rest } = r;
			return rest;
		});
		await users.updateOne({ _id: user._id }, { $set: { roles: cleaned } });
		console.log(`  Fixed: ${user.username}`);
	}

	await mongoose.disconnect();
	console.log('Done.');
}

main().catch((err) => { console.error(err); process.exit(1); });
