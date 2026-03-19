import { fail, redirect } from '@sveltejs/kit';
import { connectDB, InviteToken, User, Role, generateId } from '$lib/server/db';
import { generateSessionToken, createSession, setSessionTokenCookie } from '$lib/server/auth';
import bcrypt from 'bcryptjs';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const token = url.searchParams.get('token');
	if (!token) return { error: 'No invitation token provided' };

	await connectDB();
	const inviteDoc = await InviteToken.findOne({ token, status: 'pending' }).lean() as any;
	if (!inviteDoc) return { error: 'Invalid or expired invitation' };
	if (new Date(inviteDoc.expiresAt) < new Date()) return { error: 'Invitation has expired' };

	// Resolve role name if roleId is set
	let roleName: string | null = null;
	if (inviteDoc.roleId) {
		const role = await Role.findById(inviteDoc.roleId).lean() as any;
		roleName = role?.name ?? null;
	}

	return {
		invite: {
			email: inviteDoc.email,
			token,
			roleName
		}
	};
};

export const actions: Actions = {
	register: async (event) => {
		const form = await event.request.formData();
		const token = form.get('token')?.toString();
		const username = form.get('username')?.toString().trim();
		const password = form.get('password')?.toString();

		if (!token || !username || !password) {
			return fail(400, { error: 'All fields are required' });
		}

		await connectDB();
		const invite = await InviteToken.findOne({ token, status: 'pending' });
		if (!invite || new Date(invite.expiresAt) < new Date()) {
			return fail(400, { error: 'Invalid or expired invitation' });
		}

		const existing = await User.findOne({ username });
		if (existing) return fail(400, { error: 'Username already exists' });

		const passwordHash = await bcrypt.hash(password, 10);
		const userId = generateId();

		// Get role if specified
		let roles: any[] = [];
		let roleHistory: any[] = [];
		if (invite.roleId) {
			const role = await Role.findById(invite.roleId).lean();
			if (role) {
				const now = new Date();
				roles = [{ roleId: role._id, roleName: role.name, permissions: role.permissions, assignedAt: now }];
				roleHistory = [{ _id: generateId(), roleId: role._id, roleName: role.name, permissions: role.permissions, grantedAt: now, grantedBy: { _id: 'system', username: 'system' } }];
			}
		}

		await User.create({
			_id: userId, username, passwordHash, email: invite.email,
			roles, roleHistory, invitedBy: invite.invitedBy
		});

		invite.status = 'accepted';
		invite.acceptedAt = new Date();
		invite.createdUserId = userId;
		await invite.save();

		// Auto-login
		const sessionToken = generateSessionToken();
		const session = await createSession(sessionToken, userId);
		setSessionTokenCookie(event, sessionToken, session.expiresAt);

		redirect(302, '/');
	}
};

export const config = { maxDuration: 60 };
