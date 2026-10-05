/**
 * One colour per SPU, used on every sonic chart so a unit is the same colour everywhere.
 * 20 distinct colours (readable on the dark tron background) — with 10, an 11th/12th SPU
 * reused the 1st/2nd unit's colour and the lines became ambiguous.
 */
export const SONIC_COLORS = [
	'#38bdf8', '#fb923c', '#4ade80', '#f87171', '#c084fc', '#facc15', '#f472b6', '#2dd4bf', '#a3e635', '#818cf8',
	'#ffffff', '#e879f9', '#fde68a', '#22d3ee', '#fca5a5', '#86efac', '#fdba74', '#93c5fd', '#d946ef', '#14b8a6'
];

/** Deterministic for any index (negative / fractional / NaN included) — never undefined. */
export const sonicColor = (i: number) => {
	const n = SONIC_COLORS.length;
	const k = Number.isFinite(i) ? Math.trunc(i) : 0;
	return SONIC_COLORS[((k % n) + n) % n];
};
