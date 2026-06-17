/**
 * Shared aging thresholds for kanban tasks. Used by:
 *   - src/lib/components/kanban/KanbanTaskCard.svelte (visual border severity)
 *   - src/lib/server/kanban/analytics.ts (KPI cards / analytics aggregator)
 *
 * Keep these in sync — the analytics aging count must mirror the per-card
 * severity stripe color users already see on the board.
 */

export type AgingSeverity = 'normal' | 'warning' | 'critical';

export const agingThresholds: Record<string, { warning: number; critical: number }> = {
	backlog: { warning: 14, critical: 30 },
	ready: { warning: 5, critical: 10 },
	wip: { warning: 3, critical: 7 },
	waiting: { warning: 3, critical: 7 }
};

export function agingSeverity(status: string, daysInStatus: number | null | undefined): AgingSeverity {
	if (daysInStatus == null || status === 'done') return 'normal';
	const t = agingThresholds[status];
	if (!t) return 'normal';
	if (daysInStatus > t.critical) return 'critical';
	if (daysInStatus > t.warning) return 'warning';
	return 'normal';
}
