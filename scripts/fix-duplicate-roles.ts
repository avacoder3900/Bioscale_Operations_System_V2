/**
 * PERM-01: one-time cleanup of duplicate roles[] subdocs created by the old
 * assignRole $push bug (observed live on user zane: 2 role entries).
 * Keeps the most recently assigned entry per roleId; roleHistory is untouched.
 *
 * Usage:
 *   npx tsx scripts/fix-duplicate-roles.ts           # dry run (default)
 *   npx tsx scripts/fix-duplicate-roles.ts --apply   # write changes
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config();

const APPLY = process.argv.includes('--apply');

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const users = db.collection('users');

	const all = await users.find({}, { projection: { username: 1, roles: 1 } }).toArray();
	let touched = 0;

	for (const u of all) {
		const roles: any[] = u.roles ?? [];
		if (roles.length <= 1) continue;

		// Dedupe by roleId, keeping the entry with the latest assignedAt.
		const byRole = new Map<string, any>();
		for (const r of roles) {
			const prev = byRole.get(r.roleId);
			if (!prev || new Date(r.assignedAt ?? 0) > new Date(prev.assignedAt ?? 0)) {
				byRole.set(r.roleId, r);
			}
		}
		const deduped = [...byRole.values()];
		if (deduped.length === roles.length) {
			// Multiple DISTINCT roles — allowed historically (e.g. zane: Operator +
			// Research Admin, cross-app). Only exact-duplicate roleIds are collapsed.
			console.log(`  ${u.username}: ${roles.length} distinct roles — left as-is`);
			continue;
		}

		touched++;
		console.log(
			`  ${u.username}: ${roles.length} entries -> ${deduped.length} ` +
			`(${roles.map((r) => r.roleName).join(', ')} -> ${deduped.map((r) => r.roleName).join(', ')})` +
			(APPLY ? ' [APPLIED]' : ' [dry run]')
		);
		if (APPLY) {
			await users.updateOne({ _id: u._id }, { $set: { roles: deduped } });
		}
	}

	console.log(`\n${touched} user(s) ${APPLY ? 'fixed' : 'would be fixed'}.`);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
