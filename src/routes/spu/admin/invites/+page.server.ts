import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, InviteToken, Role, User, generateId } from '$lib/server/db';
import { requireQmsGate, writeAudit } from '$lib/server/qms-gate';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'user:read');
	await connectDB();

	const [invites, roles] = await Promise.all([
		InviteToken.find().sort({ createdAt: -1 }).lean(),
		Role.find().lean()
	]);

	const roleMap = new Map(roles.map((r: any) => [r._id, r.name]));

	// Resolve invitedBy usernames
	const inviterIds = [...new Set(invites.map((i: any) => i.invitedBy).filter(Boolean))];
	const inviters = inviterIds.length
		? await User.find({ _id: { $in: inviterIds } }, { _id: 1, username: 1 }).lean()
		: [];
	const inviterMap = new Map(inviters.map((u: any) => [u._id, u.username]));

	return {
		invites: invites.map((i: any) => ({
			id: i._id,
			email: i.email,
			roleId: i.roleId ?? null,
			roleName: i.roleId ? (roleMap.get(i.roleId) ?? null) : null,
			token: i.token,
			status: i.status,
			expiresAt: i.expiresAt.toISOString(),
			acceptedAt: i.acceptedAt?.toISOString() ?? null,
			createdAt: i.createdAt.toISOString(),
			createdBy: i.invitedBy ?? null,
			invitedByName: i.invitedBy ? (inviterMap.get(i.invitedBy) ?? null) : null
		})),
		roles: roles.map((r: any) => ({ id: r._id, name: r.name, description: r.description ?? null }))
	};
};

export const actions: Actions = {
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

		const baseUrl = event.url.origin;
		const inviteUrl = `${baseUrl}/invite/accept?token=${token}`;
		return { success: true, inviteUrl };
	},

	revokeInvite: async (event) => {
		const form = await event.request.formData();
		await requireQmsGate(event, form, {
			permission: 'user:write',
			action: 'Revoke invite',
			entityType: 'invite_token',
			entityId: form.get('inviteId')?.toString()
		});
		await connectDB();
		const inviteId = form.get('inviteId')?.toString();
		if (!inviteId) return fail(400, { error: 'Invite ID required' });

		await InviteToken.updateOne({ _id: inviteId }, { $set: { status: 'expired' } });
		await writeAudit(event, {
			tableName: 'invite_tokens',
			recordId: inviteId,
			action: 'UPDATE',
			newData: { status: 'expired' },
			changedFields: ['status']
		});
		return { success: true };
	}
};
