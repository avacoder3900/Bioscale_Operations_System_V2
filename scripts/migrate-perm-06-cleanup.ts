/**
 * PERM-06: final cleanup migration (docs/prds/PERM-06).
 *
 * ⚠️ DO NOT APPLY until the PERM-04 sweep has landed and been stable. Until every
 * legacy `requirePermission('inventory:write')`-style call site is gone, stripping
 * the legacy strings from roles would lock non-admins out of real work. Admins are
 * insulated by the admin:full+bims wildcard; Operators are NOT.
 *
 * What it does:
 *   1. Admin role   -> [bims, admin:full, + the 5 delegable gates]
 *   2. Operator role-> [bims]
 *   3. Viewer role  -> deleted (retired: reads require `bims` like everything else)
 *   4. Stale test accounts deactivated (never deleted — User has delete-only protection)
 *   5. Research-owned roles: untouched, always.
 *
 * Usage:
 *   npx tsx scripts/migrate-perm-06-cleanup.ts            # dry run (default)
 *   npx tsx scripts/migrate-perm-06-cleanup.ts --apply    # write changes
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { GATE_PERMISSIONS, PROTECTED_ROLE_NAMES } from '../src/lib/server/permissions-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');

/** Final role contents — the whole BIMS vocabulary, 8 strings total. */
const FINAL_ROLES: Record<string, string[]> = {
	Admin: ['bims', ...GATE_PERMISSIONS],
	Operator: ['bims']
};

const RETIRE_ROLES = ['Viewer'];

/** Test accounts to deactivate. `contracttest` stays active — the suite needs it. */
const DEACTIVATE_USERS = ['viewer1', 'Test Viewer 2', 'operator1', 'Test Operator 2'];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const roles = db.collection('roles');
	const users = db.collection('users');

	console.log(APPLY ? '=== APPLYING PERM-06 cleanup ===\n' : '=== DRY RUN (pass --apply to write) ===\n');

	// Safety interlock: refuse to run while legacy strings are still enforced.
	if (APPLY && process.env.PERM06_SWEEP_DONE !== 'true') {
		throw new Error(
			'Refusing to apply: set PERM06_SWEEP_DONE=true only after the PERM-04 call-site ' +
				'sweep has landed. Stripping legacy strings before then locks Operators out.'
		);
	}

	console.log('-- roles --');
	for (const [name, final] of Object.entries(FINAL_ROLES)) {
		if ((PROTECTED_ROLE_NAMES as readonly string[]).includes(name)) {
			throw new Error(`Refusing to touch research-owned role: ${name}`);
		}
		const role = await roles.findOne({ name });
		if (!role) {
			console.warn(`  ${name}: not found — skipped`);
			continue;
		}
		const current: string[] = role.permissions ?? [];
		const removed = current.filter((p) => !final.includes(p));
		if (!removed.length) {
			console.log(`  ${name}: already final (${current.length}) — no-op`);
			continue;
		}
		console.log(`  ${name}: ${current.length} -> ${final.length} perms (drops ${removed.length}: ${removed.slice(0, 6).join(', ')}${removed.length > 6 ? ', …' : ''})`);
		if (APPLY) {
			await roles.updateOne({ _id: role._id }, { $set: { permissions: final } });
			const res = await users.updateMany(
				{ 'roles.roleId': role._id },
				{ $set: { 'roles.$[r].permissions': final } },
				{ arrayFilters: [{ 'r.roleId': role._id }] }
			);
			console.log(`    propagated to ${res.modifiedCount} user(s)`);
		}
	}

	console.log('\n-- retired roles --');
	for (const name of RETIRE_ROLES) {
		const role = await roles.findOne({ name });
		if (!role) {
			console.log(`  ${name}: absent — no-op`);
			continue;
		}
		const holders = await users.countDocuments({ 'roles.roleId': role._id });
		console.log(`  ${name}: delete role, unassign from ${holders} user(s)`);
		if (APPLY) {
			await users.updateMany({ 'roles.roleId': role._id }, { $pull: { roles: { roleId: role._id } } } as any);
			await roles.deleteOne({ _id: role._id });
		}
	}

	console.log('\n-- stale accounts --');
	for (const username of DEACTIVATE_USERS) {
		const u = await users.findOne({ username }, { projection: { username: 1, isActive: 1 } });
		if (!u) {
			console.log(`  ${username}: absent — no-op`);
			continue;
		}
		if (u.isActive === false) {
			console.log(`  ${username}: already inactive — no-op`);
			continue;
		}
		console.log(`  ${username}: deactivate`);
		if (APPLY) {
			await users.updateOne(
				{ _id: u._id },
				{ $set: { isActive: false, deactivatedAt: new Date(), deactivationReason: 'PERM-06 cleanup: stale test account' } }
			);
		}
	}

	console.log('\n-- verification --');
	const active = await users.find({ isActive: true }, { projection: { username: 1, roles: 1 } }).toArray();
	for (const u of active) {
		const perms = [...new Set((u.roles ?? []).flatMap((r: any) => r.permissions ?? []))];
		console.log(`  ${u.username}: [${perms.join(', ')}]`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e instanceof Error ? e.message : e);
	process.exit(1);
});
