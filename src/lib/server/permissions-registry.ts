/**
 * PERM-02: single source of truth for every permission string in BIMS.
 *
 * This module is PURE DATA (no SvelteKit imports) so it can be imported both
 * by app code (`$lib/server/permissions-registry`) and by scripts/ via a
 * relative path. The three previously drifted lists (roles admin UI, seed
 * script, ad-hoc strings in routes) all derive from here now.
 *
 * Target model (docs/prds/PERM-00): membership permissions + admin gates.
 * The legacy vocabulary remains assignable during the migration (PERM-02..05)
 * and is deleted in PERM-06.
 */

/** Per-app membership. `bims` = everything non-admin in BIMS; `research` = the research app. */
export const MEMBERSHIP_PERMISSIONS = ['bims', 'research'] as const;

/**
 * Admin-gated activities. `admin:full` is the BIMS wildcard (scoped: only for holders of `bims`).
 *
 * `kanban:replenish` IS the tier-1 → tier-2 gate: transitionTask() refuses every
 * tier crossing unless the caller sets allowTierCrossing, and the only human path
 * that sets it is replenish.ts, which requires this permission. A separate
 * `kanban:promote` string was specced in PERM-00 but would have been a second
 * name for the same chokepoint — dropped (see PERM-04 §B).
 */
export const GATE_PERMISSIONS = [
	'admin:full',
	'document:approve',
	'kanban:replenish',
	'manufacturing:release',
	'sacred:correct',
	'assay:lock'
] as const;

/** Granted by an earlier migration, now superseded. Stripped by the PERM-02 script. */
export const DEPRECATED_PERMISSIONS = ['kanban:promote'] as const;

/**
 * Legacy vocabulary (pre-rewrite), grouped for the roles admin UI.
 * Includes the previously "used but unassignable" strings (cv:*, inventory:retract)
 * so every permission enforced anywhere in code is grantable. Removed in PERM-06.
 * Note: admin:full / document:approve live in GATE_PERMISSIONS, not here.
 */
export const LEGACY_PERMISSION_GROUPS: { group: string; permissions: string[] }[] = [
	{ group: 'admin', permissions: ['admin:users'] },
	{ group: 'user', permissions: ['user:read', 'user:write'] },
	{ group: 'role', permissions: ['role:read', 'role:write'] },
	// kanban:replenish now lives in GATE_PERMISSIONS (tier-crossing gate)
	{ group: 'kanban', permissions: ['kanban:read', 'kanban:write', 'kanban:admin'] },
	{ group: 'spu', permissions: ['spu:read', 'spu:write', 'spu:admin'] },
	{ group: 'document', permissions: ['document:read', 'document:write', 'document:train'] },
	{ group: 'inventory', permissions: ['inventory:read', 'inventory:write', 'inventory:retract'] },
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
	{ group: 'equipment', permissions: ['equipment:read', 'equipment:write'] },
	{ group: 'cleaning', permissions: ['cleaning:read', 'cleaning:write', 'cleaning:admin'] },
	{ group: 'cv', permissions: ['cv:write', 'cv:admin'] }
];

export const LEGACY_PERMISSIONS: string[] = LEGACY_PERMISSION_GROUPS.flatMap((g) => g.permissions);

/** Everything grantable from the BIMS roles admin UI. */
export const ALL_ASSIGNABLE_PERMISSIONS: string[] = [
	...new Set([...MEMBERSHIP_PERMISSIONS, ...GATE_PERMISSIONS, ...LEGACY_PERMISSIONS])
];

/** Grouped view for the roles admin UI (membership + gates first, then legacy). */
export const ASSIGNABLE_PERMISSION_GROUPS: { group: string; permissions: string[] }[] = [
	{ group: 'membership', permissions: [...MEMBERSHIP_PERMISSIONS] },
	{ group: 'adminGate', permissions: [...GATE_PERMISSIONS] },
	...LEGACY_PERMISSION_GROUPS
];

/**
 * Owned by research-v2 (shared users/roles collections). Never grantable,
 * never wildcard-satisfied, never touched by BIMS migrations.
 */
export const RESEARCH_APP_PERMISSIONS = [
	'experiment:read',
	'experiment:write',
	'experiment:delete-all',
	'user:manage'
] as const;

/** Roles owned by research-v2 — the BIMS roles admin UI must not edit or delete these. */
export const PROTECTED_ROLE_NAMES = ['Research Admin', 'Researcher'] as const;

/** Canonical BIMS role contents during the migration window (legacy + new, additive). */
export const ADMIN_ROLE_PERMISSIONS: string[] = [
	...new Set(['bims', ...GATE_PERMISSIONS, ...LEGACY_PERMISSIONS])
];
export const OPERATOR_ROLE_PERMISSIONS: string[] = [
	'bims',
	// legacy strings the Operator role has always carried — kept until PERM-06
	'kanban:read', 'spu:read', 'manufacturing:read',
	'waxFilling:read', 'waxFilling:write',
	'reagentFilling:read', 'reagentFilling:write',
	'cartridge:read', 'inventory:read',
	// Reached the one dual-role operator (zane) accidentally, via the research
	// app's role, until BIMS stopped counting research-owned roles (PERM-02).
	// None of these is an admin gate, so under the target model (`bims` = every
	// non-admin action) an Operator holds them by right — granting them here
	// keeps the interim window regression-free instead of quietly removing
	// access someone was using. Absorbed into plain `bims` at PERM-06.
	'cartridge:write', 'assay:read', 'assay:write'
];
