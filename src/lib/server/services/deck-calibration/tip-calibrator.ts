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
	| 'robot' // this robot's saved fixture
	| 'global' // the shared 'global' fallback fixture
	| 'default'; // nothing saved anywhere → the .py hardcoded point

/** The .py's hardcoded calibrator XY (relative to the carriage). */
export const DEFAULT_CALIBRATOR_XY = { x: 125.181, y: 173.247 } as const;

/**
 * mount → tip type. right = p20 (wax, 20µL rack); left = p300 (reagent, Biotix
 * 200µL rack). Same mapping as the studio's tiprackForMount and the protocols.
 */
export const TIP_FOR_MOUNT: Record<
	CalMount,
	{
		loadName: string;
		zCalKey: 'zCalWax' | 'zCalReagent';
		defaultZ: number;
		process: CalProcess;
	}
> = {
	right: {
		loadName: 'cosmasanddamian_96_tiprack_20ul',
		zCalKey: 'zCalWax',
		defaultZ: 34.491,
		process: 'wax-filling'
	},
	left: {
		loadName: 'cosmas_and_damian_biotix_96_200ul_tiprack',
		zCalKey: 'zCalReagent',
		defaultZ: 40.8,
		process: 'reagent-filling'
	}
};

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

export interface ResolvedCalibrator {
	/** The point to move to / probe at. */
	point: CalPoint;
	/** Where each part of it came from. */
	source: CalSource;
	/** The raw fixture document, when one existed (null when we fell back to the default). */
	fixture: any | null;
	/** The fixture's robotId ('global' when the shared fallback was used). */
	fixtureRobotId: string | null;
}

/**
 * Read the fixture that applies to a robot: its own row first, else the shared
 * 'global' row. Returns null when neither exists.
 */
export async function loadCalibratorFixture(
	robotId: string
): Promise<{ fixture: any | null; source: 'robot' | 'global' | 'default' }> {
	await connectDB();
	const own = (await TipCalibratorFixture.findOne({ robotId: String(robotId) }).lean()) as any;
	if (own) return { fixture: own, source: 'robot' };
	const shared = (await TipCalibratorFixture.findOne({ robotId: 'global' }).lean()) as any;
	if (shared) return { fixture: shared, source: 'global' };
	return { fixture: null, source: 'default' };
}

/**
 * The calibrator point this robot should use for the given mount, with the
 * per-mount calibration Z (zCalWax for p20/wax, zCalReagent for p300/reagent).
 */
export async function resolveCalibratorPoint(
	robotId: string,
	mount: CalMount
): Promise<ResolvedCalibrator> {
	const spec = TIP_FOR_MOUNT[mount];
	const { fixture, source } = await loadCalibratorFixture(robotId);
	return {
		point: {
			x: finite(fixture?.position?.x) ?? DEFAULT_CALIBRATOR_XY.x,
			y: finite(fixture?.position?.y) ?? DEFAULT_CALIBRATOR_XY.y,
			z: finite(fixture?.[spec.zCalKey]) ?? spec.defaultZ
		},
		source,
		fixture,
		fixtureRobotId: fixture ? String(fixture.robotId) : null
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
