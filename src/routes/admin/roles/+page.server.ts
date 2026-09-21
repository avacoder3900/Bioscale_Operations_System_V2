import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	ALL_ASSIGNABLE_PERMISSIONS,
	ASSIGNABLE_PERMISSION_GROUPS,
	PROTECTED_ROLE_NAMES
} from '$lib/server/permissions-registry';
import { connectDB, Role, User, AuditLog, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

const ASSIGNABLE = new Set(ALL_ASSIGNABLE_PERMISSIONS);

/** Research-v2 owns these roles (shared roles collection) — BIMS must not edit them. */
function isProtectedRole(name: string | undefined | null): boolean {
	return !!name && (PROTECTED_ROLE_NAMES as readonly string[]).includes(name);
}

export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'role:read');
	await connectDB();

	const [roles, userRoleCounts] = await Promise.all([
		Role.find().lean(),
		User.aggregate([
			{ $unwind: '$roles' },
			{ $group: { _id: '$roles.roleId', count: { $sum: 1 } } }
		])
	]);
	const roleCountMap = new Map(userRoleCounts.map((r: any) => [r._id, r.count]));

	// Frozen +page.svelte writes `?roleId=` when expanding a role row; older
	// callers/bookmarks use `?selected=`. Read both so the row stays expanded
	// across reloads regardless of which name produced the URL.
	const selectedRoleId = url.searchParams.get('roleId') ?? url.searchParams.get('selected');
	let selectedRole: {
		id: string;
		name: string;
		description: string | null;
		permissions: string[];
		permissionIds: string[];
	} | null = null;
	if (selectedRoleId) {
		const role = roles.find((r) => r._id === selectedRoleId);
		if (role) {
			const permIds = (role.permissions ?? []).map((p: string) => p);
			selectedRole = {
				id: role._id,
				name: role.name,
				description: role.description ?? null,
				permissions: permIds,
				permissionIds: permIds
			};
		}
	}

	return {
		roles: roles.map((r) => ({
			id: r._id,
			name: r.name,
			description: r.description ?? null,
			userCount: roleCountMap.get(r._id) ?? 0
		})),
		permissionGroups: ASSIGNABLE_PERMISSION_GROUPS.map((g) => ({
			resource: g.group,
			permissions: g.permissions.map((p) => ({
				id: p,
				name: p,
				action: p.split(':').pop() ?? p,
				description: null
			}))
		})),
		selectedRole
	};
};

export const actions: Actions = {
	createRole: async ({ request, locals }) => {
		requirePermission(locals.user, 'role:write');
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		const description = form.get('description')?.toString().trim() || undefined;
		if (!name) return fail(400, { error: 'Role name required' });

		const roleId = generateId();
		await Role.create({ _id: roleId, name, description, permissions: [] });
		await AuditLog.create({ _id: generateId(), tableName: 'roles', recordId: roleId, action: 'INSERT', changedBy: locals.user?.username, changedAt: new Date() });
		return { success: true };
	},

	updateRole: async ({ request, locals }) => {
		requirePermission(locals.user, 'role:write');
		await connectDB();
		const form = await request.formData();
		const roleId = form.get('roleId')?.toString();
		const name = form.get('name')?.toString().trim();
		const description = form.get('description')?.toString().trim();
		if (!roleId) return fail(400, { error: 'Role ID required' });

		const existing = await Role.findById(roleId).lean();
		if (!existing) return fail(404, { error: 'Role not found' });
		if (isProtectedRole(existing.name)) {
			return fail(403, { error: `"${existing.name}" is managed by the research app and cannot be edited here.` });
		}

		const updates: any = {};
		if (name) updates.name = name;
		if (description !== undefined) updates.description = description;
		await Role.updateOne({ _id: roleId }, { $set: updates });
		await AuditLog.create({ _id: generateId(), tableName: 'roles', recordId: roleId, action: 'UPDATE', changedBy: locals.user?.username, changedAt: new Date() });
		return { success: true };
	},

	deleteRole: async ({ request, locals }) => {
		requirePermission(locals.user, 'role:write');
		await connectDB();
		const form = await request.formData();
		const roleId = form.get('roleId')?.toString();
		if (!roleId) return fail(400, { error: 'Role ID required' });

		const existing = await Role.findById(roleId).lean();
		if (!existing) return fail(404, { error: 'Role not found' });
		if (isProtectedRole(existing.name)) {
			return fail(403, { error: `"${existing.name}" is managed by the research app and cannot be deleted here.` });
		}

		await Role.deleteOne({ _id: roleId });
		// Remove this role from all users
		await User.updateMany({ 'roles.roleId': roleId }, { $pull: { roles: { roleId } } });
		await AuditLog.create({ _id: generateId(), tableName: 'roles', recordId: roleId, action: 'DELETE', changedBy: locals.user?.username, changedAt: new Date() });
		return { success: true };
	},

	setPermissions: async ({ request, locals }) => {
		requirePermission(locals.user, 'role:write');
		await connectDB();
		const form = await request.formData();
		const roleId = form.get('roleId')?.toString();
		const permissions = form.getAll('permissions').map((p) => p.toString());
		if (!roleId) return fail(400, { error: 'Role ID required' });

		const role = await Role.findById(roleId);
		if (!role) return fail(400, { error: 'Role not found' });
		if (isProtectedRole(role.name)) {
			return fail(403, { error: `"${role.name}" is managed by the research app and cannot be edited here.` });
		}

		// Only registry-known strings may be persisted (closes the arbitrary-string hole).
		const invalid = permissions.filter((p) => !ASSIGNABLE.has(p));
		if (invalid.length) {
			return fail(400, { error: `Unknown permission(s): ${invalid.join(', ')}` });
		}

		role.permissions = permissions;
		await role.save();

		// Propagate to all users with this role
		await User.updateMany(
			{ 'roles.roleId': roleId },
			{ $set: { 'roles.$[r].permissions': permissions, 'roles.$[r].roleName': role.name } },
			{ arrayFilters: [{ 'r.roleId': roleId }] }
		);
		await AuditLog.create({ _id: generateId(), tableName: 'roles', recordId: roleId, action: 'UPDATE', changedBy: locals.user?.username, changedAt: new Date() });
		return { success: true };
	}
};

export const config = { maxDuration: 60 };
