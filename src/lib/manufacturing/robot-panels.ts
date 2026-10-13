/**
 * Robots page vocabulary shared by the server load and the board in the
 * browser, so it lives outside $lib/server (ROBOT-OVERHAUL, 2026-10-07).
 *
 * Round 6 (2026-10-08): the Robots page is the live command view — a robot's
 * panel shows its RUNNING wizard; setup happens on the wax-filling /
 * reagent-filling pages, reached from the panel's Start buttons. The old
 * `?open=` panel state is gone.
 */
export type BoardProcess = 'wax' | 'reagent';

export const ROBOTS_PATH = '/manufacturing/cart-mfg/robots';
export const SETUP_PATH: Record<BoardProcess, string> = {
	wax: '/manufacturing/cart-mfg/wax-filling',
	reagent: '/manufacturing/cart-mfg/reagent-filling'
};

export const panelAnchor = (robotId: string) => `#panel-${robotId}`;
