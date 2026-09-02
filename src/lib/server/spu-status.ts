/**
 * Single source of truth for the SPU status vocabulary and legal transitions
 * (SPU-INV-07 collapse). App-level enforcement matters here: nearly every SPU
 * status write uses updateOne, which skips Mongoose enum validators — the
 * schema enum alone cannot protect the data (see the historical 'assigned' bug).
 */

export const SPU_STATUSES = [
	'draft',
	'assembling',
	'validating',
	'released',
	'servicing',
	'retired'
] as const;

export type SpuStatus = (typeof SPU_STATUSES)[number];

/**
 * Legal transitions. Border statuses became transition moments: the assembly
 * e-signature is captured on assembling→validating; passing validation is the
 * event that qualifies validating→released (release itself is manual).
 * Servicing intake is allowed from any active status (the board scans whatever
 * shows up on the bench), and service return re-enters at validating by default.
 */
export const LEGAL_TRANSITIONS: Record<SpuStatus, SpuStatus[]> = {
	draft: ['assembling', 'servicing', 'retired'],
	assembling: ['draft', 'validating', 'servicing', 'retired'],
	validating: ['released', 'servicing', 'retired'],
	released: ['servicing', 'retired'],
	servicing: ['draft', 'assembling', 'validating', 'released', 'retired'],
	retired: []
};

export function isSpuStatus(value: string): value is SpuStatus {
	return (SPU_STATUSES as readonly string[]).includes(value);
}

export function isLegalTransition(from: string, to: string): boolean {
	if (!isSpuStatus(to)) return false;
	// A document still carrying a legacy status (pre-migration window) may move
	// to any current status — the collapse itself is a legal move.
	if (!isSpuStatus(from)) return true;
	return LEGAL_TRANSITIONS[from].includes(to);
}

/** Statuses a serviced unit may be returned to when its job closes. */
export const RETURNABLE_STATUSES: SpuStatus[] = [
	'draft',
	'assembling',
	'validating',
	'released',
	'retired'
];

/**
 * Collapse map for values written before SPU-INV-07. Used by the data
 * migration; kept here so any code that meets a stale value maps it the same
 * way. 'validated' maps to validating because release is manual — a device
 * that had passed validation but was never released still awaits release.
 */
export const LEGACY_STATUS_MAP: Record<string, SpuStatus> = {
	assembled: 'validating',
	validated: 'validating',
	'released-rnd': 'released',
	'released-manufacturing': 'released',
	'released-field': 'released',
	deployed: 'released',
	voided: 'retired',
	assigned: 'draft'
};

export function normalizeSpuStatus(value: string | null | undefined): SpuStatus {
	if (value && isSpuStatus(value)) return value;
	return LEGACY_STATUS_MAP[value ?? ''] ?? 'draft';
}
