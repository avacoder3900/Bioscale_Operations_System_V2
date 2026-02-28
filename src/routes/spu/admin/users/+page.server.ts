import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, User, Role, InviteToken, generateId } from '$lib/server/db';
import bcrypt from 'bcryptjs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'user:read');
	await connectDB();

	const [users, roles] = await Promise.all([
		User.find({}, { passwordHash: 0 }).sort({ createdAt: -1 }).lean(),
		Role.find().lean()
	]);

	return {
		users: users.map((u) => ({
			id: u._id,
			username: u.username,
			email: u.email ?? null,
			firstName: u.firstName ?? null,
			lastName: u.lastName ?? null,
			phone: u.phone ?? null,
			isActive: u.isActive,
			lastLoginAt: u.lastLoginAt ?? null,
			createdAt: u.createdAt,
			roles: (u.roles ?? []).map((r: any) => ({ id: r.roleId, name: r.roleName }))
		})),
		roles: roles.map((r) => ({
			id: r._id,
			name: r.name,
			description: r.description ?? null
		}))
	};
};

export const actions: Actions = {
	createUser: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const username = form.get('username')?.toString().trim();
		const password = form.get('password')?.toString();
		const email = form.get('email')?.toString().trim() || undefined;
		const firstName = form.get('firstName')?.toString().trim() || undefined;
		const lastName = form.get('lastName')?.toString().trim() || undefined;

		if (!username || !password) return fail(400, { error: 'Username and password are required' });

		const existing = await User.findOne({ username });
		if (existing) return fail(400, { error: 'Username already exists' });

		const passwordHash = await bcrypt.hash(password, 10);
		await User.create({ _id: generateId(), username, passwordHash, email, firstName, lastName });
		return { success: true };
	},

	updateProfile: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const userId = form.get('userId')?.toString();
		if (!userId) return fail(400, { error: 'User ID required' });

		const updates: any = {};
		for (const field of ['firstName', 'lastName', 'email', 'phone']) {
			const val = form.get(field)?.toString().trim();
			if (val !== undefined) updates[field] = val || undefined;
		}
		await User.updateOne({ _id: userId }, { $set: updates });
		return { success: true };
	},

	deactivateUser: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const userId = form.get('userId')?.toString();
		if (!userId) return fail(400, { error: 'User ID required' });

		await User.updateOne({ _id: userId }, {
			$set: {
				isActive: false,
				deactivatedAt: new Date(),
				deactivatedBy: { _id: locals.user!._id, username: locals.user!.username }
			}
		});
		return { success: true };
	},

	reactivateUser: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const userId = form.get('userId')?.toString();
		if (!userId) return fail(400, { error: 'User ID required' });

		await User.updateOne({ _id: userId }, {
			$set: { isActive: true },
			$unset: { deactivatedAt: '', deactivatedBy: '', deactivationReason: '' }
		});
		return { success: true };
	},

	resetPassword: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const userId = form.get('userId')?.toString();
		const newPassword = form.get('newPassword')?.toString();
		if (!userId || !newPassword) return fail(400, { error: 'User ID and password required' });

		const passwordHash = await bcrypt.hash(newPassword, 10);
		await User.updateOne({ _id: userId }, { $set: { passwordHash } });
		return { success: true };
	},

	assignRole: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const userId = form.get('userId')?.toString();
		const roleId = form.get('roleId')?.toString();
		if (!userId || !roleId) return fail(400, { error: 'User ID and role ID required' });

		const role = await Role.findById(roleId).lean();
		if (!role) return fail(400, { error: 'Role not found' });

		const now = new Date();
		await User.updateOne({ _id: userId }, {
			$push: {
				roles: { roleId: role._id, roleName: role.name, permissions: role.permissions, assignedAt: now, assignedBy: locals.user!._id },
				roleHistory: {
					_id: generateId(), roleId: role._id, roleName: role.name, permissions: role.permissions,
					grantedAt: now, grantedBy: { _id: locals.user!._id, username: locals.user!.username }
				}
			}
		});
		return { success: true };
	},

	removeRole: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const userId = form.get('userId')?.toString();
		const roleId = form.get('roleId')?.toString();
		if (!userId || !roleId) return fail(400, { error: 'User ID and role ID required' });

		const now = new Date();
		await User.updateOne({ _id: userId }, { $pull: { roles: { roleId } } });
		await User.updateOne(
			{ _id: userId, 'roleHistory.roleId': roleId, 'roleHistory.revokedAt': null },
			{ $set: {
				'roleHistory.$.revokedAt': now,
				'roleHistory.$.revokedBy': { _id: locals.user!._id, username: locals.user!.username }
			} }
		);
		return { success: true };
	},

	sendInvite: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const email = form.get('email')?.toString().trim();
		const roleId = form.get('roleId')?.toString() || undefined;
		if (!email) return fail(400, { error: 'Email required' });

		const token = generateId();
		await InviteToken.create({
			_id: generateId(), email, token, roleId,
			invitedBy: locals.user!._id,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
		});
		return { success: true, token };
	}
};
