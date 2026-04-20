/**
 * Populate the 3 existing OpentronsRobot docs with their .local hostnames
 * and serial numbers. The docs already exist (from 2026-03-20) as placeholders
 * with no ip — this fills them in.
 */
import * as dotenv from 'dotenv';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '.env') });

const MAPPING: Record<string, { ip: string; robotSerial: string }> = {
	'Robot 1': { ip: 'muddy-water.local', robotSerial: 'OT2CEP20200309B14' },
	'Robot 2': { ip: 'OT2CEP20210817R04.local', robotSerial: 'OT2CEP20210817R04' },
	'Robot 3': { ip: 'hidden-leaf.local', robotSerial: 'OT2CEP20200217B07' }
};

async function main() {
	if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
	await mongoose.connect(process.env.MONGODB_URI);
	const coll = mongoose.connection.db!.collection('opentrons_robots');

	for (const [name, patch] of Object.entries(MAPPING)) {
		const res = await coll.updateOne(
			{ name },
			{ $set: { ...patch, port: 31950, isActive: true, updatedAt: new Date() } }
		);
		console.log(`${name} → ${patch.ip} (serial=${patch.robotSerial}) — matched=${res.matchedCount} modified=${res.modifiedCount}`);
	}

	console.log('\nFinal state:');
	for (const doc of await coll.find({}).sort({ name: 1 }).toArray()) {
		console.log(`  ${doc.name} — ip=${doc.ip} serial=${doc.robotSerial} active=${doc.isActive}`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
