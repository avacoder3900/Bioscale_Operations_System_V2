/**
 * Assign optical-confirmation cartridges from a script, through the SAME code
 * path as the page (src/lib/server/optical-assign.ts). Written 2026-09-10 to
 * take over the 19 manufacturing-state cartridges Jacob's batch skipped.
 *
 *   npx tsx scripts/assign-optical-adopt.ts --group "9_10 group" --as <username> --apply <barcode...>
 *
 * Without --apply it only reports what the existing records look like.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { assignOpticalCartridges } from '../src/lib/server/optical-assign.js';
dotenv.config();

const ASSAY_ID = 'A9EB41AD';

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
	const APPLY = process.argv.includes('--apply');
	const groupName = arg('--group');
	const asUser = arg('--as');
	const barcodes = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && !['--group', '--as'].includes(all[i - 1]));
	if (!asUser || barcodes.length === 0) {
		console.error('usage: --group <name> --as <username> [--apply] <barcode...>');
		process.exit(1);
	}

	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const user = await db.collection('users').findOne({ username: asUser }, { projection: { _id: 1, username: 1 } });
	if (!user) throw new Error(`user "${asUser}" not found`);

	const existing = await db.collection('cartridge_records').find({ _id: { $in: barcodes } }).project({ status: 1, assayId: 1, assayCategory: 1, 'rawData.readings': { $slice: 1 } }).toArray();
	console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — ${barcodes.length} barcode(s), ${existing.length} already exist as cartridge_records, acting as ${user.username}, group "${groupName ?? '(none)'}"`);
	for (const e of existing) console.log(`  ${e._id}  ${e.status}  assay=${e.assayId ?? '-'}  cat=${e.assayCategory ?? '-'}  readings=${e.rawData?.readings?.length ?? 0}`);
	if (!APPLY) {
		console.log('Re-run with --apply to assign.');
		await mongoose.disconnect();
		return;
	}

	const result = await assignOpticalCartridges({
		assayId: ASSAY_ID,
		barcodes,
		groupName,
		user: { _id: String(user._id), username: user.username }
	});
	if ('error' in result) throw new Error(result.error);
	console.log(`Assigned ${result.createdCount} (adopted ${result.adopted.length}); skipped ${result.skipped.length}; group ${result.groupId}`);
	for (const a of result.adopted) console.log(`  adopted ${a.barcode} (was ${a.priorStatus})`);
	for (const s of result.skipped) console.log(`  skipped ${s.barcode}: ${s.reason}`);
	await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
