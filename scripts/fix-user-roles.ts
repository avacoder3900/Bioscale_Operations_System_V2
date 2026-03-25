/**
 * Fix user roles that were scrambled by the AI agent.
 * Also fix the assignRole action to replace instead of push.
 *
 * Usage: npx tsx scripts/fix-user-roles.ts [--dry-run]
 */
import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';
import { nanoid } from 'nanoid';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: resolve(__dirname, '..', '.env') });

const dryRun = process.argv.includes('--dry-run');

const ROLE_ASSIGNMENTS: Record<string, string> = {
	contracttest: 'Operator',
	operator1: 'Operator',
	viewer1: 'Viewer',
	alejandro: 'Admin',
	jacob: 'Admin',
	javier: 'Admin',
	andres: 'Admin',
	nick: 'Admin',
	zane: 'Operator',
	l3: 'Admin',
};

const DELETE_USERS = ['admin'];

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;
	const users = db.collection('users');
	const roles = db.collection('roles');

	console.log(dryRun ? 'DRY RUN\n' : 'LIVE RUN\n');

	// Get role documents
	const adminRole = await roles.findOne({ name: 'Admin' });
	const operatorRole = await roles.findOne({ name: 'Operator' });
	const viewerRole = await roles.findOne({ name: 'Viewer' });

	if (!adminRole || !operatorRole || !viewerRole) {
		console.error('Missing roles:', { admin: !!adminRole, operator: !!operatorRole, viewer: !!viewerRole });
		process.exit(1);
	}

	const roleMap: Record<string, any> = { Admin: adminRole, Operator: operatorRole, Viewer: viewerRole };

	console.log('Roles:');
	console.log(`  Admin: ${adminRole._id} (${adminRole.permissions.length} perms)`);
	console.log(`  Operator: ${operatorRole._id} (${operatorRole.permissions.length} perms)`);
	console.log(`  Viewer: ${viewerRole._id} (${viewerRole.permissions.length} perms)\n`);

	const now = new Date();

	// Delete useless accounts
	for (const username of DELETE_USERS) {
		const user = await users.findOne({ username });
		if (!user) {
			console.log(`DELETE SKIP: ${username} not found`);
			continue;
		}
		console.log(`DELETE: ${username} (_id: ${user._id})`);
		if (!dryRun) {
			await users.deleteOne({ _id: user._id });
			// Also delete their sessions
			await db.collection('sessions').deleteMany({ userId: user._id });
			console.log('  DELETED (user + sessions)\n');
		} else {
			console.log('  DRY RUN — would delete\n');
		}
	}

	// Fix role assignments
	for (const [username, targetRoleName] of Object.entries(ROLE_ASSIGNMENTS)) {
		const user = await users.findOne({ username });
		if (!user) {
			console.log(`SKIP: ${username} not found`);
			continue;
		}

		const targetRole = roleMap[targetRoleName];
		const currentRoles = (user.roles || []).map((r: any) => r.roleName).join(', ') || '(none)';
		const currentPermCount = (user.roles || []).reduce((sum: number, r: any) => sum + (r.permissions?.length || 0), 0);

		const alreadyCorrect =
			user.roles?.length === 1 &&
			user.roles[0].roleId === targetRole._id &&
			user.roles[0].permissions?.length === targetRole.permissions.length;

		if (alreadyCorrect) {
			console.log(`OK: ${username} — already [${currentRoles}] (${currentPermCount} perms)`);
			continue;
		}

		console.log(`FIX: ${username} — [${currentRoles}] (${currentPermCount} perms) → [${targetRoleName}] (${targetRole.permissions.length} perms)`);

		if (dryRun) {
			console.log('  DRY RUN — would update\n');
			continue;
		}

		await users.updateOne({ _id: user._id }, {
			$set: {
				roles: [{
					roleId: targetRole._id,
					roleName: targetRole.name,
					permissions: targetRole.permissions,
					assignedAt: now,
					assignedBy: 'fix-user-roles-script'
				}]
			},
			$push: {
				roleHistory: {
					_id: nanoid(),
					roleId: targetRole._id,
					roleName: targetRole.name,
					permissions: targetRole.permissions,
					grantedAt: now,
					grantedBy: { _id: 'system', username: 'fix-user-roles-script' }
				}
			}
		});

		console.log(`  UPDATED\n`);
	}

	// Clean up orphaned custom roles (created by agent)
	const knownRoleIds = [adminRole._id, operatorRole._id, viewerRole._id];
	const allRoles = await roles.find({}).toArray();
	for (const role of allRoles) {
		if (!knownRoleIds.includes(role._id)) {
			console.log(`\nOrphaned role: "${role.name}" (${role._id}) — ${role.permissions?.length || 0} perms`);
			if (!dryRun) {
				await roles.deleteOne({ _id: role._id });
				console.log('  DELETED');
			} else {
				console.log('  DRY RUN — would delete');
			}
		}
	}

	// Final state
	console.log('\n--- Final state ---');
	const allUsers = await users.find({}, { projection: { username: 1, 'roles.roleName': 1, 'roles.permissions': 1 } }).sort({ username: 1 }).toArray();
	for (const u of allUsers) {
		const roleNames = (u.roles || []).map((r: any) => r.roleName).join(', ') || '(none)';
		const permCount = (u.roles || []).reduce((sum: number, r: any) => sum + (r.permissions?.length || 0), 0);
		console.log(`  ${u.username}: [${roleNames}] (${permCount} perms)`);
	}

	await mongoose.disconnect();
	console.log('\nDone.');
}

main().catch((err) => { console.error(err); process.exit(1); });
