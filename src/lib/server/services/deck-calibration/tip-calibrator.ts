/**
 * Tip-calibrator geometry — ONE place that answers "where is the calibrator?".
 *
 * Three consumers used to each carry their own copy of the calibrator point and
 * the mount → tip-type mapping (the probe endpoint, the protocol RTP builder,
 * and the .py itself). They drifted. This module is now the single source:
 *
 *   per-robot TipCalibratorFixture  →  the 'global' fixture  →  the .py default
 *
 * Nothing here writes to the database. Persisting a taught point is the
 * deck-calibration page's `saveCalibrator` action; this module only reads.
 *
 * ROBOT-VALIDATION-GATED: the numbers below are the values the .py hardcoded.
 * They are a LAST-RESORT fallback for a robot that has never been taught, not a
 * measurement, and they are never returned as if they were a probe result.
 */
import { connectDB, TipCalibratorFixture } from '$lib/server/db';

export type CalMount = 'left' | 'right';
export type CalProcess = 'wax-filling' | 'reagent-filling';

export interface CalPoint {
	x: number;
	y: number;
	z: number;
}

/** Where the point we're using came from — surfaced in the UI so the operator knows. */
export type CalSource =
	| 'jogged' // operator taught it live in this session (not saved yet)
	| 'deck' // the mounted deck's own saved fixture (the 2026-08-28 key)
	| 'legacy-robot' // a pre-rekey row still stored against the robot
	| 'robot' // (legacy alias, kept so old callers still typecheck)
	| 'global' // the shared fallback fixture
	| 'default'; // nothing saved anywhere → the .py hardcoded point

/** The .py's hardcoded calibrator XY (relative to the carriage). */
export const DEFAULT_CALIBRATOR_XY = { x: 125.181, y: 173.247 } as const;

/**
 * Which tip is being calibrated. This is an OPERATOR CHOICE, never inferred.
 *
 * This used to be a mount → tip mapping (TIP_FOR_MOUNT: right = p20/wax,
 * left = p300/reagent). That assumption is false on this fleet — the pipettes
 * are not always on those mounts — and it silently picked both the wrong
 * calibration Z and the wrong tiprack definition:
 *
 *   p300 on the right  → 34.491 instead of 40.8 = 6.309 mm too LOW (crash)
 *   p20  on the left   → 40.8 instead of 34.491 = 6.309 mm too high (no reading)
 *
 * Mount now only says which arm to move. The profile says what is on it.
 */
export type TipProfile = 'wax' | 'reagent';

export const TIP_PROFILE: Record<
	TipProfile,
	{
		loadName: string;
		zCalKey: 'zCalWax' | 'zCalReagent';
		defaultZ: number;
		process: CalProcess;
		pipette: string;
	}
> = {
	wax: {
		loadName: 'cosmasanddamian_96_tiprack_20ul',
		zCalKey: 'zCalWax',
		defaultZ: 34.491,
		process: 'wax-filling',
		pipette: 'p20'
	},
	reagent: {
		loadName: 'cosmas_and_damian_biotix_96_200ul_tiprack',
		zCalKey: 'zCalReagent',
		defaultZ: 40.8,
		process: 'reagent-filling',
		pipette: 'p300'
	}
};

/** Narrow untrusted input to a TipProfile. Returns undefined — never a guess. */
export function asTipProfile(v: unknown): TipProfile | undefined {
	const s = typeof v === 'string' ? v.trim() : '';
	return s === 'wax' || s === 'reagent' ? s : undefined;
}

/** process → the fixture field + default that carries its calibration Z. */
export const Z_CAL_FOR_PROCESS: Record<
	CalProcess,
	{ zCalKey: 'zCalWax' | 'zCalReagent'; defaultZ: number }
> = {
	'wax-filling': { zCalKey: 'zCalWax', defaultZ: 34.491 },
	'reagent-filling': { zCalKey: 'zCalReagent', defaultZ: 40.8 }
};

/** Finite-number guard: anything not a real number becomes undefined, never 0. */
export function finite(v: unknown): number | undefined {
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
}

/**
 * The Z window a calibrator height has to fall inside to be believed, in mm.
 *
 * This is the OT-2's usable Z envelope, not a tolerance around any taught
 * point — deliberately wide, so it only ever catches garbage and never an
 * operator legitimately re-teaching a height. Both ends are load-bearing and
 * they fail in opposite directions: under the floor the pipette drives into the
 * fixture (a crash), over the ceiling it never touches off (no reading).
 *
 * Shared with the deck-calibration page so a bad number is refused at the form,
 * before the robot is ever asked to move to it.
 */
export const CAL_Z_LIMITS = { min: 5, max: 200 } as const;

/**
 * Z guard: a real number INSIDE CAL_Z_LIMITS, else undefined.
 *
 * Stricter than finite() because 0 is the dangerous case. The fixture schema's
 * `vec` defaults every axis to 0, so a partial write materialises as a literal
 * 0 that is indistinguishable from a taught value — and 0 is straight through
 * the deck. Anything outside the window means NOT TAUGHT, so callers fall back
 * to the .py default instead of commanding it.
 *
 * Rejects rather than clamps: a clamp would quietly move the pipette to a height
 * nobody asked for, which is worse than refusing to move at all.
 *
 * Pure and DB-free on purpose — form validation runs it on raw request input.
 */
export function plausibleZ(v: unknown): number | undefined {
	const n = finite(v);
	if (n === undefined) return undefined;
	return n >= CAL_Z_LIMITS.min && n <= CAL_Z_LIMITS.max ? n : undefined;
}

/**
 * XY guard: a real, non-zero coordinate, else undefined.
 *
 * The same "a stored 0 is not a taught value" problem as plausibleZ, for the
 * same reason — `vec` defaults x and y to 0 too — so a half-written fixture
 * would otherwise send the tip to the deck's front-left corner at full
 * confidence.
 *
 * Deliberately no range window: CAL_Z_LIMITS is a Z envelope, and an XY window
 * would be invented rather than measured. Zero-vs-taught is the failure this
 * fleet actually has.
 */
export function taughtXY(v: unknown): number | undefined {
	const n = finite(v);
	return n === undefined || n === 0 ? undefined : n;
}

export interface ResolvedCalibrator {
	/** The point to move to / probe at. */
	point: CalPoint;
	/** Where each part of it came from. */
	source: CalSource;
	/** The raw fixture document, when one existed (null when we fell back to the default). */
	fixture: any | null;
	/** The fixture's robotId ('global' when the shared fallback was used). */
	fixtureRobotId: string | null;
	/** The deck the resolved fixture belongs to, when it is deck-keyed. */
	fixtureDeck?: { deckKey: string | null; deckLoadName: string | null };
}

/**
 * Read the fixture that applies to a robot: its own row first, else the shared
 * 'global' row. Returns null when neither exists.
 */
export interface DeckRef {
	/** Calibrator/carriage Particle device id — the authoritative key. */
	deckKey?: string | null;
	/** Human deck load name, used when no Particle id is known. */
	deckLoadName?: string | null;
}

/**
 * Read the fixture that applies to a DECK (2026-08-28), falling back through
 * the legacy robot-keyed row and the shared 'global' row.
 *
 * Order matters and is the whole point of the rework: the fixture is bolted to
 * the carriage, so the deck's own row must win over anything stored against the
 * robot. The robot row is consulted only for pairs not yet migrated, and is
 * reported as 'legacy-robot' so callers can nudge an operator to re-teach.
 */
export async function loadCalibratorFixture(
	robotId: string,
	deck: DeckRef = {}
): Promise<{ fixture: any | null; source: 'deck' | 'legacy-robot' | 'global' | 'default' }> {
	await connectDB();
	if (deck.deckKey) {
		const byKey = (await TipCalibratorFixture.findOne({ deckKey: String(deck.deckKey) }).lean()) as any;
		if (byKey) return { fixture: byKey, source: 'deck' };
	}
	if (deck.deckLoadName) {
		const byName = (await TipCalibratorFixture.findOne({ deckLoadName: String(deck.deckLoadName) }).lean()) as any;
		if (byName) return { fixture: byName, source: 'deck' };
	}
	// Legacy: rows written before the deck rekey (deckKey absent).
	const own = (await TipCalibratorFixture.findOne({
		robotId: String(robotId),
		deckKey: null
	}).lean()) as any;
	if (own) return { fixture: own, source: 'legacy-robot' };
	const shared = (await TipCalibratorFixture.findOne({ deckKey: 'global' }).lean())
		?? (await TipCalibratorFixture.findOne({ robotId: 'global' }).lean()) as any;
	if (shared) return { fixture: shared as any, source: 'global' };
	return { fixture: null, source: 'default' };
}

/**
 * The calibrator point this robot should use for the tip being calibrated.
 *
 * Takes the operator's explicit TipProfile, NOT the mount: zCalWax for the
 * p20/wax tip, zCalReagent for the p300/reagent tip. Passing a mount here is
 * what caused the 6.309 mm wrong-Z bug — the signature is deliberately typed
 * so that mistake no longer compiles.
 */
export async function resolveCalibratorPoint(
	robotId: string,
	profile: TipProfile,
	deck: DeckRef = {}
): Promise<ResolvedCalibrator> {
	const spec = TIP_PROFILE[profile];
	const { fixture, source } = await loadCalibratorFixture(robotId, deck);
	return {
		point: {
			// Guarded, not merely finite: a stored 0, or a Z outside the envelope,
			// means this fixture was never fully taught on that axis. Falling back to
			// the .py default is the only safe reading of it — see the guards above.
			x: taughtXY(fixture?.position?.x) ?? DEFAULT_CALIBRATOR_XY.x,
			y: taughtXY(fixture?.position?.y) ?? DEFAULT_CALIBRATOR_XY.y,
			z: plausibleZ(fixture?.[spec.zCalKey]) ?? spec.defaultZ
		},
		source,
		fixture,
		fixtureRobotId: fixture ? String(fixture.robotId) : null,
		fixtureDeck: fixture
			? { deckKey: fixture.deckKey ?? null, deckLoadName: fixture.deckLoadName ?? null }
			: undefined
	};
}

/**
 * Apply an operator's jogged point on top of the saved one, axis by axis.
 *
 * The wizard's whole point is "probe where I just put the tip", so a taught
 * coordinate always wins — but only if it is a real number. A missing or
 * garbage axis silently keeps the saved value rather than collapsing to 0,
 * which would slam the pipette into the deck corner.
 */
export function applyCalibratorOverride(
	base: CalPoint,
	override: { x?: unknown; y?: unknown; z?: unknown } | null | undefined
): { point: CalPoint; overridden: boolean } {
	const x = finite(override?.x);
	const y = finite(override?.y);
	const z = finite(override?.z);
	const overridden = x !== undefined || y !== undefined || z !== undefined;
	return {
		point: { x: x ?? base.x, y: y ?? base.y, z: z ?? base.z },
		overridden
	};
}

/** How we obtained the probed centre — the UI shows this next to the numbers. */
export type ProbedSource = 'bridge' | 'derived-from-adjust';

export interface ProbeReading {
	/** The measured centre in deck coordinates, or null when the robot reported none. */
	probed: CalPoint | null;
	probedSource: ProbedSource | null;
	/** Per-tip offset from nominal, as measured by the limit switches. */
	adjust: { x: number; y: number } | null;
}

/**
 * Pull the measurement out of whatever the bridge posted back.
 *
 * ROBOT-VALIDATION-GATED — this function NEVER invents a reading:
 *   • a centre reported by the robot (probed / center / measured) is used as-is;
 *   • otherwise, if the robot measured an adjust, the centre is derived as
 *     commanded + adjust and labelled 'derived-from-adjust';
 *   • with neither, probed is null. The commanded point is never echoed back as
 *     though it had been measured.
 */
export function readProbeResult(body: any, commanded: CalPoint): ProbeReading {
	const ax = finite(body?.adjust?.x);
	const ay = finite(body?.adjust?.y);
	const adjust = ax !== undefined && ay !== undefined ? { x: ax, y: ay } : null;

	// The daemon may report the measured centre directly under any of these keys.
	for (const raw of [body?.probed, body?.center, body?.centre, body?.measured]) {
		const px = finite(raw?.x);
		const py = finite(raw?.y);
		if (px !== undefined && py !== undefined) {
			return {
				probed: { x: px, y: py, z: finite(raw?.z) ?? commanded.z },
				probedSource: 'bridge',
				adjust
			};
		}
	}

	if (adjust) {
		// Grounded in a real measurement: where we told it to go, plus how far off
		// the switches found the tip to be.
		return {
			probed: { x: commanded.x + adjust.x, y: commanded.y + adjust.y, z: commanded.z },
			probedSource: 'derived-from-adjust',
			adjust
		};
	}

	return { probed: null, probedSource: null, adjust: null };
}
