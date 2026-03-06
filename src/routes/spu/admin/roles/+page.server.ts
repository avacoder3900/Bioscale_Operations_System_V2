import { fail } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, Role, User, generateId } from '$lib/server/db';
import type { Actions, PageServerLoad } from './$types';

// All available permissions grouped
const ALL_PERMISSIONS = [
	{ group: 'admin', permissions: ['admin:full', 'admin:users'] },
	{ group: 'user', permissions: ['user:read', 'user:write'] },
	{ group: 'role', permissions: ['role:read', 'role:write'] },
	{ group: 'kanban', permissions: ['kanban:read', 'kanban:write', 'kanban:admin'] },
	{ group: 'spu', permissions: ['spu:read', 'spu:write', 'spu:admin'] },
	{ group: 'document', permissions: ['document:read', 'document:write', 'document:approve', 'document:train'] },
	{ group: 'inventory', permissions: ['inventory:read', 'inventory:write'] },
	{ group: 'cartridge', permissions: ['cartridge:read', 'cartridge:write'] },
	{ group: 'cartridgeAdmin', permissions: ['cartridgeAdmin:read', 'cartridgeAdmin:write'] },
	{ group: 'assay', permissions: ['assay:read', 'assay:write'] },
	{ group: 'device', permissions: ['device:read', 'device:write'] },
	{ group: 'testResult', permissions: ['testResult:read', 'testResult:write'] },
	{ group: 'manufacturing', permissions: ['manufacturing:read', 'manufacturing:write', 'manufacturing:admin'] },
	{ group: 'waxFilling', permissions: ['waxFilling:read', 'waxFilling:write'] },
	{ group: 'reagentFilling', permissions: ['reagentFilling:read', 'reagentFilling:write'] },
	{ group: 'workInstruction', permissions: ['workInstruction:read', 'workInstruction:write', 'workInstruction:approve'] },
	{ group: 'documentRepo', permissions: ['documentRepo:read', 'documentRepo:write'] },
	{ group: 'productionRun', permissions: ['productionRun:read', 'productionRun:write'] },
	{ group: 'shipping', permissions: ['shipping:read', 'shipping:write'] },
	{ group: 'customer', permissions: ['customer:read', 'customer:write'] },
	{ group: 'equipment', permissions: ['equipment:read', 'equipment:write'] }
];

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

	const selectedRoleId = url.searchParams.get('selected');
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
		permissionGroups: ALL_PERMISSIONS.map((g) => ({
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

		await Role.create({ _id: generateId(), name, description, permissions: [] });
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

		const updates: any = {};
		if (name) updates.name = name;
		if (description !== undefined) updates.description = description;
		await Role.updateOne({ _id: roleId }, { $set: updates });
		return { success: true };
	},

	deleteRole: async ({ request, locals }) => {
		requirePermission(locals.user, 'role:write');
		await connectDB();
		const form = await request.formData();
		const roleId = form.get('roleId')?.toString();
		if (!roleId) return fail(400, { error: 'Role ID required' });

		await Role.deleteOne({ _id: roleId });
		// Remove this role from all users
		await User.updateMany({ 'roles.roleId': roleId }, { $pull: { roles: { roleId } } });
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

		role.permissions = permissions;
		await role.save();

		// Propagate to all users with this role
		await User.updateMany(
			{ 'roles.roleId': roleId },
			{ $set: { 'roles.$[r].permissions': permissions, 'roles.$[r].roleName': role.name } },
			{ arrayFilters: [{ 'r.roleId': roleId }] }
		);
		return { success: true };
	}
};
