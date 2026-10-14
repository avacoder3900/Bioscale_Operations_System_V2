/**
 * Robots page vocabulary shared by the server load and the board in the
 * browser, so it lives outside $lib/server (ROBOT-OVERHAUL, 2026-10-07).
 *
 * Round 6 (2026-10-08): the Robots page is the live command view — a robot's
 * panel shows its RUNNING wizard.
 *
 * Inline setup (2026-10-14): setup happens IN the robot's panel on the Robots
 * page as well. `?open=<robotId>:wax,<robotId>:reagent` names the idle robots
 * whose setup wizard the operator opened (a robot with a run already in
 * Setup / Loading is open regardless), so a refresh keeps the panel open. The
 * wax-filling / reagent-filling pages still exist as full-page fallbacks
 * (SETUP_PATH) — nothing was removed from them.
 */
export type BoardProcess = 'wax' | 'reagent';

export const ROBOTS_PATH = '/manufacturing/cart-mfg/robots';
export const SETUP_PATH: Record<BoardProcess, string> = {
	wax: '/manufacturing/cart-mfg/wax-filling',
	reagent: '/manufacturing/cart-mfg/reagent-filling'
};

export const panelAnchor = (robotId: string) => `#panel-${robotId}`;

/** Query param on /robots naming the idle robots with an open setup panel. */
export const OPEN_PARAM = 'open';

/** `"<robotId>:wax,<robotId>:reagent"` → map. Unknown processes are dropped. */
export function parseOpen(raw: string | null | undefined): Record<string, BoardProcess> {
	const out: Record<string, BoardProcess> = {};
	if (!raw) return out;
	for (const part of raw.split(',')) {
		const i = part.lastIndexOf(':');
		if (i <= 0) continue;
		const robotId = part.slice(0, i);
		const process = part.slice(i + 1);
		if (process === 'wax' || process === 'reagent') out[robotId] = process;
	}
	return out;
}

export function serializeOpen(open: Record<string, BoardProcess>): string {
	return Object.entries(open)
		.map(([id, p]) => `${id}:${p}`)
		.join(',');
}

function withOpenMap(url: URL, open: Record<string, BoardProcess>): string {
	const next = new URL(url);
	const s = serializeOpen(open);
	if (s) next.searchParams.set(OPEN_PARAM, s);
	else next.searchParams.delete(OPEN_PARAM);
	return next.pathname + next.search;
}

/** The same URL with this robot's setup panel opened on `process`. */
export function withOpen(url: URL, robotId: string, process: BoardProcess): string {
	return withOpenMap(url, { ...parseOpen(url.searchParams.get(OPEN_PARAM)), [robotId]: process });
}

/** The same URL with this robot's entry removed — null when it was not open (nothing to change). */
export function withoutOpen(url: URL, robotId: string): string | null {
	const open = parseOpen(url.searchParams.get(OPEN_PARAM));
	if (!(robotId in open)) return null;
	delete open[robotId];
	return withOpenMap(url, open);
}
