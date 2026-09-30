/** One colour per SPU, used on every sonic chart so a unit is the same colour everywhere. */
export const SONIC_COLORS = ['#38bdf8', '#fb923c', '#4ade80', '#f87171', '#c084fc', '#facc15', '#f472b6', '#2dd4bf', '#a3a3a3', '#818cf8'];

/** Deterministic for any index (negative / fractional / NaN included) — never undefined. */
export const sonicColor = (i: number) => {
	const n = SONIC_COLORS.length;
	const k = Number.isFinite(i) ? Math.trunc(i) : 0;
	return SONIC_COLORS[((k % n) + n) % n];
};
