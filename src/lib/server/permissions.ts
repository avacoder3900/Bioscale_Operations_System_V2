/**
 * Permission checking utilities.
 * Permissions are stored as strings in user.roles[].permissions[] (e.g., "kanban:read", "spu:write")
 */

interface UserWithRoles {
	roles?: { roleId: string; roleName: string; permissions: string[] }[];
}

export function hasPermission(user: UserWithRoles | null, permission: string): boolean {
	if (!user?.roles) return false;
	return user.roles.some((role) => role.permissions.includes(permission));
}

export function hasAnyPermission(user: UserWithRoles | null, permissions: string[]): boolean {
	if (!user?.roles) return false;
	const allPerms = user.roles.flatMap((r) => r.permissions);
	return permissions.some((p) => allPerms.includes(p));
}

export function requirePermission(user: UserWithRoles | null, permission: string): void {
	if (!hasPermission(user, permission)) {
		throw new Error(`Permission denied: requires ${permission}`);
	}
}

export function isAdmin(user: UserWithRoles | null): boolean {
	return hasPermission(user, 'admin:full') || hasPermission(user, 'admin:users');
}

/**
 * Get all unique permissions for a user across all their roles
 */
export function getAllPermissions(user: UserWithRoles | null): string[] {
	if (!user?.roles) return [];
	return [...new Set(user.roles.flatMap((r) => r.permissions))];
}

/**
 * Get permission groups from flat permission list
 * e.g., ["kanban:read", "kanban:write", "spu:read"] -> { kanban: ["read", "write"], spu: ["read"] }
 */
export function getPermissionGroups(permissions: string[]): Record<string, string[]> {
	const groups: Record<string, string[]> = {};
	for (const perm of permissions) {
		const [group, action] = perm.split(':');
		if (!groups[group]) groups[group] = [];
		groups[group].push(action);
	}
	return groups;
}
