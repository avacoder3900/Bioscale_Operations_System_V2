/**
 * Robots page panels (ROBOT-OVERHAUL round 2, 2026-10-07) — shared by the
 * server load and the board in the browser, so it lives outside $lib/server.
 *
 * Which wizards are open on /manufacturing/cart-mfg/robots is URL state:
 *   ?open=<robotId>:wax,<robotId>:reagent
 * Every robot has a panel. A robot with a run in progress is locked to that
 * process; the param records which process the operator chose for an idle one.
 */
export type BoardProcess = 'wax' | 'reagent';

export const ROBOTS_PATH = '/manufacturing/cart-mfg/robots';

export function parseOpenPanels(raw: string | null | undefined): Map<string, BoardProcess> {
	const m = new Map<string, BoardProcess>();
	for (const part of (raw ?? '').split(',')) {
		const i = part.lastIndexOf(':');
		if (i <= 0) continue;
		const id = part.slice(0, i).trim();
		const p = part.slice(i + 1).trim();
		if (id && (p === 'wax' || p === 'reagent')) m.set(id, p);
	}
	return m;
}

export function serializeOpenPanels(m: Map<string, BoardProcess>): string {
	return [...m].map(([id, p]) => `${id}:${p}`).join(',');
}

/** The /robots URL with one robot's panel added, switched or removed. */
export function panelsHref(current: Map<string, BoardProcess>, robotId: string, process: BoardProcess | null, anchor = true): string {
	const next = new Map(current);
	if (process) next.set(robotId, process);
	else next.delete(robotId);
	const q = serializeOpenPanels(next);
	return `${ROBOTS_PATH}${q ? `?open=${q}` : ''}${process && anchor ? `#panel-${robotId}` : ''}`;
}

export const panelAnchor = (robotId: string) => `#panel-${robotId}`;
