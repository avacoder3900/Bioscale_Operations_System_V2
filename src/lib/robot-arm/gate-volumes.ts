/**
 * Wax per gate on the robot-arm wax fill line (Run tab Setup, 2026-11-09).
 *
 * A cart row is four wax holes, one per gate; the stage protocol takes the
 * volume of each as vol_gate1 … vol_gate4. Until now the arm line sent none of
 * them, so its fills ran on the .py's 1.6 µL defaults while the carriage line
 * ran its wizard's 1.8 / 2.2 / 2.2 / 2.2. Setup now holds the four volumes and
 * every loop sends them; the defaults are the carriage line's
 * (WaxWizard.svelte WAX_PARAM_DEFAULTS).
 *
 * Pure: shared by the server, the page and the tests.
 */

export const GATE_KEYS = ['g1', 'g2', 'g3', 'g4'] as const;
export type GateKey = (typeof GATE_KEYS)[number];
export type GateVolumes = Record<GateKey, number>;

/** The carriage line's volumes: a row is 8.4 µL, inside the 8.5 µL one p20 aspiration holds over an 11.5 µL remainder. */
export const GATE_VOLUME_DEFAULTS: GateVolumes = { g1: 1.8, g2: 2.2, g3: 2.2, g4: 2.2 };

/** The stage protocol's vol_gate range, µL. */
export const GATE_VOLUME_LIMITS = { min: 0.1, max: 20 } as const;

/** The stage protocol's maximum_volume_per_aspiration (the p20), µL. */
export const MAX_PER_ASPIRATION_UL = 20;

export const GATES: { key: GateKey; gate: 1 | 2 | 3 | 4; rtp: string; label: string }[] = [
	{ key: 'g1', gate: 1, rtp: 'vol_gate1', label: 'Gate 1' },
	{ key: 'g2', gate: 2, rtp: 'vol_gate2', label: 'Gate 2' },
	{ key: 'g3', gate: 3, rtp: 'vol_gate3', label: 'Gate 3' },
	{ key: 'g4', gate: 4, rtp: 'vol_gate4', label: 'Gate 4' }
];

const round2 = (v: number) => Math.round(v * 100) / 100;

const inRange = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= GATE_VOLUME_LIMITS.min && v <= GATE_VOLUME_LIMITS.max;

/** The stored volumes; a gate never saved (or saved out of range) reads as the default. */
export function gateVolumesFrom(stored: unknown): GateVolumes {
	const o = stored && typeof stored === 'object' ? (stored as Record<string, unknown>) : {};
	const out = { ...GATE_VOLUME_DEFAULTS };
	for (const k of GATE_KEYS) if (inRange(o[k])) out[k] = round2(o[k] as number);
	return out;
}

/** Setup's four boxes → volumes, to 0.01 µL. Throws with the gate and the range when one is not a volume. */
export function parseGateVolumes(input: Partial<Record<GateKey, unknown>>): GateVolumes {
	const out = { ...GATE_VOLUME_DEFAULTS };
	for (const g of GATES) {
		const raw = input[g.key];
		const text = String(raw ?? '').trim();
		const v = text === '' ? NaN : Number(text);
		if (!Number.isFinite(v)) throw new Error(`${g.label} volume must be a number.`);
		const r = round2(v);
		if (!inRange(r)) throw new Error(`${g.label} volume must be ${GATE_VOLUME_LIMITS.min}–${GATE_VOLUME_LIMITS.max} µL.`);
		out[g.key] = r;
	}
	return out;
}

/** One row of the cart: the four gates, µL. */
export function rowTotalUl(v: GateVolumes): number {
	return round2(GATE_KEYS.reduce((s, k) => s + v[k], 0));
}

/**
 * Tube trips one row takes: the protocol's plan_batches fills gates 4 → 1 and
 * starts a new aspiration when the next hole would not fit in what one
 * aspiration holds over the remainder.
 */
export function tripsPerRow(v: GateVolumes, aspirateRemainderUl: number): number {
	const usable = MAX_PER_ASPIRATION_UL - aspirateRemainderUl;
	let trips = 1;
	let held = 0;
	for (const k of [...GATE_KEYS].reverse()) {
		if (held > 0 && held + v[k] > usable + 1e-9) {
			trips += 1;
			held = 0;
		}
		held += v[k];
	}
	return trips;
}

/** "1.8 / 2.2 / 2.2 / 2.2" — gates 1 to 4. */
export function gateVolumesText(v: GateVolumes): string {
	return GATE_KEYS.map((k) => v[k]).join(' / ');
}
