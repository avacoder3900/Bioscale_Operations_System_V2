/**
 * PERM-02 permission-matrix unit tests (docs/prds/PERM-02 acceptance).
 * Run: npm run test:unit
 */
import { describe, it, expect } from 'vitest';
import { hasPermission, hasAnyPermission, isAdmin } from './permissions';
import {
	ADMIN_ROLE_PERMISSIONS,
	OPERATOR_ROLE_PERMISSIONS,
	GATE_PERMISSIONS
} from './permissions-registry';

const role = (roleName: string, permissions: string[]) => ({
	roleId: `${roleName}-id`,
	roleName,
	permissions
});

const admin = { username: 'admin-user', roles: [role('Admin', ADMIN_ROLE_PERMISSIONS)] };
const wildcardOnlyAdmin = { username: 'lean-admin', roles: [role('Admin', ['bims', 'admin:full'])] };
const operator = { username: 'op', roles: [role('Operator', OPERATOR_ROLE_PERMISSIONS)] };
const researchAdmin = {
	username: 'research-admin',
	roles: [
		role('Research Admin', [
			'experiment:read', 'experiment:write', 'experiment:delete-all',
			'cartridge:read', 'cartridge:write', 'assay:read', 'assay:write',
			'user:manage', 'admin:full'
		])
	]
};
// zane-shaped: legitimate cross-app dual role
const dualRole = { username: 'zane', roles: [operator.roles[0], researchAdmin.roles[0]] };

describe('hasPermission — membership + gates', () => {
	it('denies everything for null user', () => {
		expect(hasPermission(null, 'bims')).toBe(false);
		expect(hasPermission(null, 'admin:full')).toBe(false);
	});

	it('Admin holds bims and every gate', () => {
		expect(hasPermission(admin, 'bims')).toBe(true);
		for (const gate of GATE_PERMISSIONS) expect(hasPermission(admin, gate)).toBe(true);
	});

	it('Operator holds bims but no gate', () => {
		expect(hasPermission(operator, 'bims')).toBe(true);
		for (const gate of GATE_PERMISSIONS) expect(hasPermission(operator, gate)).toBe(false);
	});
});

describe('hasPermission — scoped admin:full wildcard', () => {
	it('admin:full + bims satisfies any BIMS permission, even unheld legacy strings', () => {
		expect(wildcardOnlyAdmin.roles[0].permissions).not.toContain('inventory:write');
		expect(hasPermission(wildcardOnlyAdmin, 'inventory:write')).toBe(true);
		expect(hasPermission(wildcardOnlyAdmin, 'manufacturing:release')).toBe(true);
		expect(hasPermission(wildcardOnlyAdmin, 'some-future:permission')).toBe(true);
	});

	it('wildcard never grants research-app permissions', () => {
		expect(hasPermission(wildcardOnlyAdmin, 'research')).toBe(false);
		expect(hasPermission(wildcardOnlyAdmin, 'experiment:write')).toBe(false);
		expect(hasPermission(wildcardOnlyAdmin, 'user:manage')).toBe(false);
	});

	it('admin:full WITHOUT bims is not a wildcard', () => {
		const unscoped = { username: 'x', roles: [role('Custom', ['admin:full'])] };
		expect(hasPermission(unscoped, 'inventory:write')).toBe(false);
		expect(hasPermission(unscoped, 'admin:full')).toBe(true); // direct hold still counts
	});
});

describe('hasPermission — research-owned roles are ignored in BIMS', () => {
	it('Research Admin alone satisfies NO BIMS check, including its own admin:full/cartridge:*', () => {
		expect(hasPermission(researchAdmin, 'bims')).toBe(false);
		expect(hasPermission(researchAdmin, 'admin:full')).toBe(false);
		expect(hasPermission(researchAdmin, 'cartridge:read')).toBe(false);
		expect(isAdmin(researchAdmin)).toBe(false);
	});

	it('dual-role user (Operator + Research Admin) evaluates as Operator only', () => {
		expect(hasPermission(dualRole, 'bims')).toBe(true);
		expect(hasPermission(dualRole, 'waxFilling:write')).toBe(true);
		// The research role's admin:full must NOT combine with the BIMS role's
		// bims to trip the wildcard:
		expect(hasPermission(dualRole, 'manufacturing:release')).toBe(false);
		expect(isAdmin(dualRole)).toBe(false);
	});
});

describe('hasAnyPermission — wildcard-consistent', () => {
	it('routes through hasPermission so the wildcard applies', () => {
		expect(hasAnyPermission(wildcardOnlyAdmin, ['cv:write', 'manufacturing:write'])).toBe(true);
		expect(hasAnyPermission(researchAdmin, ['cv:write', 'manufacturing:write'])).toBe(false);
	});
});
