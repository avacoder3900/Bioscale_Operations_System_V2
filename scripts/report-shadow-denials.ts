/**
 * PERM-03: aggregate the permission shadow log so the PERM-04 flip decision is
 * data-driven. Read-only.
 *
 * Usage: npx tsx scripts/report-shadow-denials.ts [--days 7]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const daysArg = process.argv.indexOf('--days');
const DAYS = daysArg > -1 ? Number(process.argv[daysArg + 1]) || 7 : 7;

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

	const rows = await db
		.collection('permission_shadow_log')
		.aggregate([
			{ $match: { createdAt: { $gte: since } } },
			{
				$group: {
					_id: { username: '$username', reason: '$reason', path: '$path', method: '$method' },
					count: { $sum: 1 },
					lastSeen: { $max: '$createdAt' }
				}
			},
			{ $sort: { count: -1 } }
		])
		.toArray();

	console.log(`=== Shadow denials, last ${DAYS} day(s): ${rows.length} distinct (caller, path) pairs ===\n`);
	if (!rows.length) {
		console.log('No would-be denials. If the shadow window is ≥7 days, PERM-04 can flip.');
	}
	for (const r of rows) {
		const k = r._id;
		console.log(
			`  ${String(r.count).padStart(5)}×  ${k.username ?? '<anon>'}  ${k.method} ${k.path}  [${k.reason}]  last ${new Date(r.lastSeen).toISOString()}`
		);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
