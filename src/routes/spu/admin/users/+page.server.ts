import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, User, Role, InviteToken, Session, generateId } from '$lib/server/db';
import {
	requireQmsGate,
	writeAudit,
	guardLastAdmin,
	guardNotSelf,
	passwordPolicyError
} from '$lib/server/qms-gate';
import bcrypt from 'bcryptjs';
import type { Actions, PageServerLoad } from './$types';

const ADMIN_PERMISSIONS = ['admin:full', 'admin:users'];
const grantsAdmin = (perms: string[] = []) => perms.some((p) => ADMIN_PERMISSIONS.includes(p));

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
			roles: (u.roles ?? []).map((r: any): { id: string; name: string } => ({ id: r.roleId, name: r.roleName }))
		})),
		roles: roles.map((r) => ({
			id: r._id,
			name: r.name,
			description: r.description ?? null
		}))
	};
};

export const actions: Actions = {
	createUser: async (event) => {
		const form = await event.request.formData();
		const { actor } = await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Create user',
			entityType: 'user'
		});
		await connectDB();
		const username = form.get('username')?.toString().trim();
		const password = form.get('password')?.toString();
		const email = form.get('email')?.toString().trim() || undefined;
		const firstName = form.get('firstName')?.toString().trim() || undefined;
		const lastName = form.get('lastName')?.toString().trim() || undefined;

		if (!username || !password) return fail(400, { error: 'Username and password are required' });
		const pwErr = passwordPolicyError(password, username);
		if (pwErr) return fail(400, { error: pwErr });

		const existing = await User.findOne({ username });
		if (existing) return fail(400, { error: 'Username already exists' });

		const passwordHash = await bcrypt.hash(password, 10);
		const userId = generateId();
		await User.create({ _id: userId, username, passwordHash, email, firstName, lastName });
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'INSERT',
			newData: { username, email, firstName, lastName, createdBy: actor.username }
		});
		return { success: true };
	},

	updateProfile: async (event) => {
		const form = await event.request.formData();
		await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Update user profile',
			entityType: 'user',
			entityId: form.get('userId')?.toString()
		});
		await connectDB();
		const userId = form.get('userId')?.toString();
		if (!userId) return fail(400, { error: 'User ID required' });

		const updates: any = {};
		for (const field of ['firstName', 'lastName', 'email', 'phone']) {
			const val = form.get(field)?.toString().trim();
			if (val !== undefined) updates[field] = val || undefined;
		}
		await User.updateOne({ _id: userId }, { $set: updates });
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'UPDATE',
			newData: updates,
			changedFields: Object.keys(updates)
		});
		return { success: true };
	},

	deactivateUser: async (event) => {
		const form = await event.request.formData();
		await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Deactivate user',
			entityType: 'user',
			entityId: form.get('userId')?.toString()
		});
		await connectDB();
		const userId = form.get('userId')?.toString();
		if (!userId) return fail(400, { error: 'User ID required' });

		// Anti-lockout guards (enforced in both phases).
		guardNotSelf(event, userId, 'deactivate');
		await guardLastAdmin(userId);

		await User.updateOne({ _id: userId }, {
			$set: {
				isActive: false,
				deactivatedAt: new Date(),
				deactivatedBy: { _id: event.locals.user!._id, username: event.locals.user!.username }
			}
		});
		// Cut access immediately — a deactivated user must not keep a live session.
		await Session.deleteMany({ userId });
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'UPDATE',
			newData: { isActive: false },
			changedFields: ['isActive']
		});
		return { success: true };
	},

	reactivateUser: async (event) => {
		const form = await event.request.formData();
		await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Reactivate user',
			entityType: 'user',
			entityId: form.get('userId')?.toString()
		});
		await connectDB();
		const userId = form.get('userId')?.toString();
		if (!userId) return fail(400, { error: 'User ID required' });

		await User.updateOne({ _id: userId }, {
			$set: { isActive: true },
			$unset: { deactivatedAt: '', deactivatedBy: '', deactivationReason: '' }
		});
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'UPDATE',
			newData: { isActive: true },
			changedFields: ['isActive']
		});
		return { success: true };
	},

	resetPassword: async (event) => {
		const form = await event.request.formData();
		await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Reset password',
			entityType: 'user',
			entityId: form.get('userId')?.toString()
		});
		await connectDB();
		const userId = form.get('userId')?.toString();
		const newPassword = form.get('newPassword')?.toString();
		if (!userId || !newPassword) return fail(400, { error: 'User ID and password required' });
		const pwErr = passwordPolicyError(newPassword);
		if (pwErr) return fail(400, { error: pwErr });

		const passwordHash = await bcrypt.hash(newPassword, 10);
		await User.updateOne({ _id: userId }, { $set: { passwordHash } });
		// Invalidate the target's existing sessions so an old login can't persist.
		await Session.deleteMany({ userId });
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'UPDATE',
			newData: { passwordReset: true },
			changedFields: ['passwordHash'],
			reason: 'Administrative password reset'
		});
		return { success: true };
	},

	assignRole: async (event) => {
		const form = await event.request.formData();
		const { actor } = await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Assign role',
			entityType: 'user',
			entityId: form.get('userId')?.toString()
		});
		await connectDB();
		const userId = form.get('userId')?.toString();
		const roleId = form.get('roleId')?.toString();
		if (!userId || !roleId) return fail(400, { error: 'User ID and role ID required' });

		const role = await Role.findById(roleId).lean();
		if (!role) return fail(400, { error: 'Role not found' });

		const now = new Date();
		await User.updateOne({ _id: userId }, {
			$push: {
				roles: { roleId: role._id, roleName: role.name, permissions: role.permissions, assignedAt: now, assignedBy: actor._id },
				roleHistory: {
					_id: generateId(), roleId: role._id, roleName: role.name, permissions: role.permissions,
					grantedAt: now, grantedBy: { _id: actor._id, username: actor.username }
				}
			}
		});
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'UPDATE',
			newData: { roleAssigned: { roleId: role._id, roleName: role.name } },
			changedFields: ['roles']
		});
		return { success: true };
	},

	removeRole: async (event) => {
		const form = await event.request.formData();
		const { actor } = await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Remove role',
			entityType: 'user',
			entityId: form.get('userId')?.toString()
		});
		await connectDB();
		const userId = form.get('userId')?.toString();
		const roleId = form.get('roleId')?.toString();
		if (!userId || !roleId) return fail(400, { error: 'User ID and role ID required' });

		// If this role grants admin, make sure we're not stripping the last admin.
		const role = (await Role.findById(roleId).lean()) as any;
		if (role && grantsAdmin(role.permissions)) {
			await guardLastAdmin(userId);
		}

		const now = new Date();
		await User.updateOne({ _id: userId }, { $pull: { roles: { roleId } } });
		await User.updateOne(
			{ _id: userId, 'roleHistory.roleId': roleId, 'roleHistory.revokedAt': null },
			{ $set: {
				'roleHistory.$.revokedAt': now,
				'roleHistory.$.revokedBy': { _id: actor._id, username: actor.username }
			} }
		);
		await writeAudit(event, {
			tableName: 'users',
			recordId: userId,
			action: 'UPDATE',
			newData: { roleRemoved: roleId },
			changedFields: ['roles']
		});
		return { success: true };
	},

	sendInvite: async (event) => {
		const form = await event.request.formData();
		const { actor } = await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Send invite',
			entityType: 'invite_token'
		});
		await connectDB();
		const email = form.get('email')?.toString().trim();
		const roleId = form.get('roleId')?.toString() || undefined;
		if (!email) return fail(400, { error: 'Email required' });

		const token = generateId();
		const inviteId = generateId();
		await InviteToken.create({
			_id: inviteId, email, token, roleId,
			invitedBy: actor._id,
			expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
		});
		await writeAudit(event, {
			tableName: 'invite_tokens',
			recordId: inviteId,
			action: 'INSERT',
			newData: { email, roleId }
		});
		return { success: true, token };
	}
};
