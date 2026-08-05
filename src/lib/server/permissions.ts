/**
 * Permission checking utilities.
 * Permissions are stored as strings in user.roles[].permissions[] (e.g., "kanban:read", "spu:write")
 *
 * PERM-02: `admin:full` acts as a wildcard for every BIMS permission, but only
 * for users who also hold the `bims` membership permission, and never for the
 * research app's permissions. This scoping matters because the users/roles
 * collections are shared with research-v2, whose "Research Admin" role also
 * carries `admin:full` — without the `bims` requirement those users would
 * satisfy every BIMS check. See docs/prds/PERM-00.
 */
import { error } from '@sveltejs/kit';
import { RESEARCH_APP_PERMISSIONS, PROTECTED_ROLE_NAMES } from './permissions-registry';

interface UserWithRoles {
	roles?: { roleId: string; roleName: string; permissions: string[] }[];
}

/** Permissions the admin:full wildcard must never satisfy. */
const WILDCARD_EXCLUDED = new Set<string>(['research', ...RESEARCH_APP_PERMISSIONS]);

/**
 * Permissions granted by research-v2's roles (shared roles collection) count
 * for NOTHING in BIMS. Without this, "Research Admin" (which carries
 * admin:full + cartridge:* + assay:*) satisfies BIMS admin checks — and a
 * user holding a research role alongside a BIMS role would trip the
 * admin:full+bims wildcard across roles (observed live: zane).
 */
function bimsPermissions(user: UserWithRoles): string[] {
	return (user.roles ?? [])
		.filter((r) => !(PROTECTED_ROLE_NAMES as readonly string[]).includes(r.roleName))
		.flatMap((r) => r.permissions);
}

export function hasPermission(user: UserWithRoles | null, permission: string): boolean {
	if (!user?.roles) return false;
	const allPerms = bimsPermissions(user);
	if (allPerms.includes(permission)) return true;
	// Scoped wildcard: admin:full + bims satisfies any BIMS-side permission.
	if (WILDCARD_EXCLUDED.has(permission)) return false;
	return allPerms.includes('admin:full') && allPerms.includes('bims');
}

export function hasAnyPermission(user: UserWithRoles | null, permissions: string[]): boolean {
	return permissions.some((p) => hasPermission(user, p));
}

export function requirePermission(user: UserWithRoles | null, permission: string): void {
	if (!hasPermission(user, permission)) {
		throw error(403, `Permission denied: requires ${permission}`);
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
