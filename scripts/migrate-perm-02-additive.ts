/**
 * PERM-02: additive permission migration (docs/prds/PERM-02).
 *
 * Adds the new-model permissions to the live BIMS roles and propagates them to
 * user role snapshots. Strictly additive — no string is removed, so the app
 * behaves identically until enforcement ships (PERM-03/04). Research-v2's
 * roles (Research Admin, Researcher) are never touched.
 *
 *   Admin    += bims + the 6 admin gates
 *   Operator += bims
 *   Viewer   unchanged (retired in PERM-06)
 *
 * Usage:
 *   npx tsx scripts/migrate-perm-02-additive.ts           # dry run (default)
 *   npx tsx scripts/migrate-perm-02-additive.ts --apply   # write changes
 *
 * Idempotent: re-running after apply is a no-op.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { GATE_PERMISSIONS, PROTECTED_ROLE_NAMES } from '../src/lib/server/permissions-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const APPLY = process.argv.includes('--apply');

const ADDITIONS: Record<string, string[]> = {
	Admin: ['bims', ...GATE_PERMISSIONS],
	Operator: ['bims']
};

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const roles = db.collection('roles');
	const users = db.collection('users');

	for (const [roleName, additions] of Object.entries(ADDITIONS)) {
		if ((PROTECTED_ROLE_NAMES as readonly string[]).includes(roleName)) {
			throw new Error(`Refusing to touch research-owned role: ${roleName}`);
		}
		const role = await roles.findOne({ name: roleName });
		if (!role) {
			console.warn(`  Role "${roleName}" not found — skipped`);
			continue;
		}
		const current: string[] = role.permissions ?? [];
		const missing = additions.filter((p) => !current.includes(p));
		if (!missing.length) {
			console.log(`  ${roleName}: already migrated (${current.length} perms) — no-op`);
			continue;
		}
		const next = [...current, ...missing];
		console.log(`  ${roleName}: +[${missing.join(', ')}] -> ${next.length} perms${APPLY ? ' [APPLIED]' : ' [dry run]'}`);
		if (APPLY) {
			await roles.updateOne({ _id: role._id }, { $set: { permissions: next } });
			// Propagate to every user's denormalized snapshot of this role
			// (same pattern as the roles admin UI's setPermissions action).
			const res = await users.updateMany(
				{ 'roles.roleId': role._id },
				{ $set: { 'roles.$[r].permissions': next } },
				{ arrayFilters: [{ 'r.roleId': role._id }] }
			);
			console.log(`    propagated to ${res.modifiedCount} user(s)`);
		}
	}

	// Verification: every active user with their post-migration membership state.
	console.log('\n=== Active users after migration ===');
	const active = await users
		.find({ isActive: true }, { projection: { username: 1, roles: 1 } })
		.toArray();
	for (const u of active) {
		const perms = new Set<string>((u.roles ?? []).flatMap((r: any) => r.permissions ?? []));
		const flags = [
			perms.has('bims') ? 'bims' : '—',
			perms.has('admin:full') ? 'admin:full' : '',
			perms.has('research') || (u.roles ?? []).some((r: any) => (PROTECTED_ROLE_NAMES as readonly string[]).includes(r.roleName)) ? 'research-side' : ''
		].filter(Boolean);
		console.log(`  ${u.username}: ${(u.roles ?? []).map((r: any) => r.roleName).join(', ') || '<no role>'} [${flags.join(', ')}] (${perms.size} perms)`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
