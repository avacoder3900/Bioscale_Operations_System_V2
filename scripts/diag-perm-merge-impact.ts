/**
 * Pre-merge safety check: for every active user, compute which permissions they
 * satisfied under the OLD logic (flat match across all roles, no wildcard) vs the
 * NEW logic (research-owned roles ignored; admin:full wildcard scoped to `bims`).
 *
 * Anything in the LOSES column is a real access regression to review before merge.
 * Read-only.
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import {
	LEGACY_PERMISSIONS,
	GATE_PERMISSIONS,
	RESEARCH_APP_PERMISSIONS,
	PROTECTED_ROLE_NAMES
} from '../src/lib/server/permissions-registry';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const ALL_CHECKS = [...new Set([...LEGACY_PERMISSIONS, ...GATE_PERMISSIONS, 'bims'])];
const WILDCARD_EXCLUDED = new Set<string>(['research', ...RESEARCH_APP_PERMISSIONS]);

/** Pre-PERM-02 behaviour. */
function oldHas(roles: any[], perm: string): boolean {
	return roles.some((r) => (r.permissions ?? []).includes(perm));
}

/** Current behaviour (mirrors src/lib/server/permissions.ts). */
function newHas(roles: any[], perm: string): boolean {
	const bims = roles
		.filter((r) => !(PROTECTED_ROLE_NAMES as readonly string[]).includes(r.roleName))
		.flatMap((r) => r.permissions ?? []);
	if (bims.includes(perm)) return true;
	if (WILDCARD_EXCLUDED.has(perm)) return false;
	return bims.includes('admin:full') && bims.includes('bims');
}

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const users = await mongoose.connection
		.db!.collection('users')
		.find({ isActive: true }, { projection: { username: 1, roles: 1 } })
		.toArray();

	let regressions = 0;
	for (const u of users) {
		const roles = u.roles ?? [];
		const lost = ALL_CHECKS.filter((p) => oldHas(roles, p) && !newHas(roles, p));
		const gained = ALL_CHECKS.filter((p) => !oldHas(roles, p) && newHas(roles, p));
		const roleNames = roles.map((r: any) => r.roleName).join(' + ') || '<none>';

		if (!lost.length && !gained.length) {
			console.log(`  ${u.username} (${roleNames}): no change`);
			continue;
		}
		console.log(`\n  ${u.username} (${roleNames}):`);
		if (lost.length) {
			regressions++;
			console.log(`    LOSES  (${lost.length}): ${lost.join(', ')}`);
		}
		if (gained.length) console.log(`    gains  (${gained.length}): ${gained.join(', ')}`);
	}

	console.log(
		`\n${regressions} user(s) lose at least one permission. Review each before merging.`
	);
	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
