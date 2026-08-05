import mongoose from 'mongoose';
import * as dotenv from 'dotenv';
dotenv.config({ path: 'C:/Users/jacobq/Documents/GitHub/Bioscale_Operations_System_V2/.env' });

async function main() {
	await mongoose.connect(process.env.MONGODB_URI!);
	const db = mongoose.connection.db!;

	const users = await db
		.collection('users')
		.find({}, { projection: { username: 1, isActive: 1, roles: 1, lastLoginAt: 1 } })
		.toArray();

	console.log('=== Users by role ===');
	for (const u of users) {
		const roleNames = (u.roles ?? []).map((r: any) => r.roleName).join(', ') || '<no role>';
		const permCount = (u.roles ?? []).reduce((n: number, r: any) => n + (r.permissions?.length ?? 0), 0);
		const dupes = (u.roles ?? []).length > 1 ? ` [${u.roles.length} role entries]` : '';
		const last = u.lastLoginAt ? new Date(u.lastLoginAt).toISOString().slice(0, 10) : 'never';
		console.log(
			`  ${u.username}: ${roleNames}${dupes} — ${permCount} perms — ${u.isActive ? 'active' : 'INACTIVE'} — last login ${last}`
		);
	}

	console.log('\n=== Roles collection ===');
	const roles = await db.collection('roles').find({}).toArray();
	for (const r of roles) {
		console.log(`  ${r.name}: ${(r.permissions ?? []).length} permissions`);
	}

	await mongoose.disconnect();
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
