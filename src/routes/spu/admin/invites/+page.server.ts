import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, InviteToken, Role, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'user:read');
	await connectDB();

	const [invites, roles] = await Promise.all([
		InviteToken.find().sort({ createdAt: -1 }).lean(),
		Role.find().lean()
	]);

	return {
		invites: invites.map((i) => ({
			id: i._id, email: i.email, roleId: i.roleId ?? null,
			token: i.token, status: i.status, expiresAt: i.expiresAt.toISOString(),
			acceptedAt: i.acceptedAt?.toISOString() ?? null,
			createdAt: i.createdAt.toISOString(), createdBy: i.invitedBy ?? null
		})),
		roles: roles.map((r) => ({ id: r._id, name: r.name, description: r.description ?? null }))
	};
};

export const actions: Actions = {
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
		return { success: true };
	},

	revokeInvite: async ({ request, locals }) => {
		requirePermission(locals.user, 'user:write');
		await connectDB();
		const form = await request.formData();
		const inviteId = form.get('inviteId')?.toString();
		if (!inviteId) return fail(400, { error: 'Invite ID required' });

		await InviteToken.updateOne({ _id: inviteId }, { $set: { status: 'expired' } });
		return { success: true };
	}
};
