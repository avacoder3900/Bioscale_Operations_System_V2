/**
 * Two-tier kanban status vocabulary — THE single source of truth.
 * Client-safe (no server imports). See docs/prds/KB2-00-OVERVIEW.md + KB2-01.
 *
 * Every status string in the app must come from here: the Mongoose enum, UI
 * columns, badges, aging thresholds, analytics buckets, agent-API groupings,
 * and MCP tool schemas. Do not write status string literals anywhere else.
 */

// Tier 1 — upstream, uncommitted. Unbounded inventory of options.
export const TIER1_STATUSES = ['captured', 'processed', 'icebox', 'declined'] as const;

// Tier 2 — downstream, committed. Bounded, one globally ordered queue.
export const TIER2_STATUSES = ['ready', 'wip', 'waiting', 'blocked', 'review', 'done'] as const;

export const ALL_STATUSES = [...TIER1_STATUSES, ...TIER2_STATUSES] as const;
export type KanbanStatus = (typeof ALL_STATUSES)[number];

export const ITEM_TYPES = ['deliverable', 'spike', 'chore'] as const;
export type KanbanItemType = (typeof ITEM_TYPES)[number];

export const CLASSES_OF_SERVICE = ['standard', 'fixed_date', 'chore', 'expedite'] as const;
export type KanbanClassOfService = (typeof CLASSES_OF_SERVICE)[number];

export const SIZE_CLASSES = ['short', 'medium', 'long'] as const;
export type KanbanSizeClass = (typeof SIZE_CLASSES)[number];

export const ORIGINS = ['planned', 'discovered'] as const;
export type KanbanOrigin = (typeof ORIGINS)[number];

const TIER1_SET: ReadonlySet<string> = new Set(TIER1_STATUSES);
const TIER2_SET: ReadonlySet<string> = new Set(TIER2_STATUSES);

export function isKanbanStatus(s: string): s is KanbanStatus {
	return TIER1_SET.has(s) || TIER2_SET.has(s);
}

/** Tier is DERIVED from status — never stored, never independently writable. */
export function tierOf(status: KanbanStatus): 1 | 2 {
	return TIER1_SET.has(status) ? 1 : 2;
}

/** A tier crossing is the commitment point (or its unwind). Privileged — replenish/demote only. */
export function isTierCrossing(from: KanbanStatus, to: KanbanStatus): boolean {
	return tierOf(from) !== tierOf(to);
}

// KB2-16: the ops/software board discriminator is gone — one board, tags carry
// the distinction (`software` is just a tag) and `review` is legal everywhere.

export const STATUS_META: Record<KanbanStatus, { label: string; color: string; tier: 1 | 2 }> = {
	captured: { label: 'Captured', color: '#94a3b8', tier: 1 },
	processed: { label: 'Processed', color: '#818cf8', tier: 1 },
	icebox: { label: 'Icebox', color: '#38bdf8', tier: 1 },
	declined: { label: 'Declined', color: '#6b7280', tier: 1 },
	ready: { label: 'Ready', color: '#a78bfa', tier: 2 },
	wip: { label: 'In Progress', color: '#f59e0b', tier: 2 },
	waiting: { label: 'Waiting', color: '#f97316', tier: 2 },
	blocked: { label: 'Blocked', color: '#ef4444', tier: 2 },
	review: { label: 'In Review', color: '#22d3ee', tier: 2 },
	done: { label: 'Done', color: '#10b981', tier: 2 }
};

/**
 * Aging thresholds (days in status) → warn / critical. Replaces the old
 * kanban-aging.ts module (deleted) and the duplicated copy in KanbanTaskCard.
 * Tier 1 parked states and terminal states deliberately do not age.
 */
export const AGING_THRESHOLDS: Partial<Record<KanbanStatus, { warn: number; critical: number }>> = {
	captured: { warn: 30, critical: 90 },
	processed: { warn: 21, critical: 60 },
	ready: { warn: 7, critical: 14 },
	wip: { warn: 5, critical: 10 },
	waiting: { warn: 3, critical: 7 },
	blocked: { warn: 2, critical: 5 },
	review: { warn: 2, critical: 5 }
};

export type AgingLevel = 'normal' | 'warn' | 'critical';

export function agingLevel(status: KanbanStatus, daysInStatus: number): AgingLevel {
	const t = AGING_THRESHOLDS[status];
	if (!t) return 'normal';
	if (daysInStatus >= t.critical) return 'critical';
	if (daysInStatus >= t.warn) return 'warn';
	return 'normal';
}

/** Per-status date-stamp field on the task document (transition service writes these). */
export const STATUS_DATE_FIELD: Record<KanbanStatus, string | null> = {
	captured: null,
	processed: 'processedDate',
	icebox: null,
	declined: 'declinedDate',
	ready: 'readyDate',
	wip: 'wipDate',
	waiting: 'waitingDate',
	blocked: 'blockedDate',
	review: 'reviewDate',
	done: 'completedDate'
};
