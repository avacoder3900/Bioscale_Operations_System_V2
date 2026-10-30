/**
 * ARM-WAX-LOOP-B — the handshake between BIMS and the stage protocol when ONE
 * OT-2 run serves a whole robot-arm wax-fill loop
 * (docs/prds/ARM-WAX-LOOP-B-ONE-RUN-PER-LOOP.md §5). Pure: shared by the
 * server (arm-wax-fill.ts), the page and the tests.
 *
 *  - BIMS → protocol: an INSTRUCTION FILE on the robot, written by the bridge
 *    daemon (`write_file`), one record at a time, seq increasing.
 *  - protocol → BIMS: PAUSE MESSAGES — `protocol.pause('ARM PARKED 2')` is a
 *    waitForResume command whose params.message BIMS reads.
 */

/** The one file the daemon may write for this line (§5.1 / §5.5). */
export const ARM_LOOP_INSTRUCTION_PATH = '/data/arm_loop.json';

export type ArmLoopAction = 'start' | 'scan' | 'fill' | 'skip' | 'end';

export interface ArmLoopInstruction {
	/** 0 for the start record, then +1 per write within the loop. */
	seq: number;
	/** The BIMS ArmWaxFillRun _id; the protocol ignores a record for another loop. */
	loop: string;
	/** 1-based cart index the instruction is for. */
	cart: number;
	action: ArmLoopAction;
	/** The scanned barcode on `fill`, else null. */
	barcode: string | null;
}

export type ArmPauseKind = 'PARKED' | 'AT_SCAN' | 'NO_INSTRUCTION';

export interface ArmPause {
	kind: ArmPauseKind;
	/** PARKED <i>: ready for cart i. AT_SCAN <i>: over the stage for cart i. NO_INSTRUCTION <i>: resumed without one. */
	cart: number;
}

const PAUSE_RE = /^\s*ARM\s+(PARKED|AT_SCAN|NO_INSTRUCTION)\s+(\d+)\b/;

/** `ARM PARKED 3` → { kind: 'PARKED', cart: 3 }; anything else → null. */
export function parseArmPause(message: unknown): ArmPause | null {
	if (typeof message !== 'string') return null;
	const m = PAUSE_RE.exec(message);
	if (!m) return null;
	return { kind: m[1] as ArmPauseKind, cart: Number(m[2]) };
}

/** Any pause the arm line owns (never one for an operator or the engine to auto-resume). */
export function isArmPauseMessage(message: unknown): boolean {
	return typeof message === 'string' && /^\s*ARM\s/.test(message);
}

/** The arm may move only in this state: the tip parked in the wax tube, the run paused for this cart. */
export function isParkedFor(pause: ArmPause | null, cart: number): boolean {
	return !!pause && pause.kind === 'PARKED' && pause.cart === cart;
}

/**
 * ARM-WAX-LOOP-B overlap (Alejandro, 2026-10-30): besides the pauses, the
 * protocol ANNOUNCES two moments with a plain comment, and the arm may move
 * from them on while the run keeps going:
 *   'ARM CALIBRATED'  — the once-per-loop probe is done; the OT-2 now only
 *                       visits the tube (aspirate, park) until 'ARM PARKED 1'.
 *   'ARM CLEAR <i>'   — cart i's fill (or skip / end) has left the stage and
 *                       arrived at the tube; the OT-2 now only re-aspirates and
 *                       parks (or trashes the tip and homes) until the next pause.
 * A marker is the LAST ARM pause or announcement in the run's command log; a
 * later marker (a resumed pause on the way to the scan, say) retires it.
 */
export type ArmMarkerKind = ArmPauseKind | 'CALIBRATED' | 'CLEAR';

export interface ArmMarker {
	kind: ArmMarkerKind;
	/** The cart for PARKED / AT_SCAN / NO_INSTRUCTION / CLEAR; 0 for CALIBRATED. */
	cart: number;
	/** True for a waitForResume the run is paused at right now. */
	paused: boolean;
}

const COMMENT_RE = /^\s*ARM\s+(CALIBRATED|CLEAR)(?:\s+(\d+))?\b/;

/** 'ARM CLEAR 2' → { kind: 'CLEAR', cart: 2 }; 'ARM CALIBRATED' → { kind: 'CALIBRATED', cart: 0 }; other comments → null. */
export function parseArmComment(message: unknown): { kind: 'CALIBRATED' | 'CLEAR'; cart: number } | null {
	if (typeof message !== 'string') return null;
	const m = COMMENT_RE.exec(message);
	if (!m) return null;
	return { kind: m[1] as 'CALIBRATED' | 'CLEAR', cart: m[2] ? Number(m[2]) : 0 };
}

export interface ArmMoveWant {
	/** The pause that always allows the move: 'ARM PARKED <parked>'. */
	parked: number;
	/** Also allowed while the run is RUNNING after 'ARM CLEAR <orClear>' (nothing later in the log). */
	orClear?: number;
	/** Also allowed while the run is RUNNING after 'ARM CALIBRATED' (nothing later in the log). */
	orCalibrated?: boolean;
}

export interface ArmMoveContext {
	/** The ARM marker before `last` in the log (for a NO_INSTRUCTION: where the run was paused when it got resumed). */
	prev?: ArmMarker | null;
	/**
	 * BIMS has sent NO instruction for this park yet. Then a park that was resumed
	 * from outside the loop (the controller's Resume, 2026-10-30) has not moved the
	 * gantry: the protocol only polls the instruction file where it stands, then
	 * pauses 'ARM NO_INSTRUCTION <i>' — still in the wax tube. Both states count as
	 * parked. Once BIMS HAS sent an instruction a running run after that park is on
	 * its way to the stage and never counts.
	 */
	uninstructed?: boolean;
}

/** May the arm move now, given the run's status and its last ARM marker? */
export function armMayMove(status: string, last: ArmMarker | null, want: ArmMoveWant, ctx: ArmMoveContext = {}): boolean {
	if (!last) return false;
	if (last.kind === 'PARKED' && last.cart === want.parked && last.paused && status === 'paused') return true;
	// A park resumed without an instruction: paused again as NO_INSTRUCTION, or still polling.
	if (ctx.uninstructed && last.kind === 'NO_INSTRUCTION' && last.cart === want.parked && last.paused && status === 'paused' && ctx.prev?.kind === 'PARKED' && ctx.prev.cart === want.parked) return true;
	if (ctx.uninstructed && last.kind === 'PARKED' && last.cart === want.parked && !last.paused && status === 'running') return true;
	if (status !== 'running') return false;
	if (want.orCalibrated && last.kind === 'CALIBRATED') return true;
	if (want.orClear != null && last.kind === 'CLEAR' && last.cart === want.orClear) return true;
	return false;
}

/** The run is effectively at 'ARM AT_SCAN <cart>': paused there, or paused NO_INSTRUCTION right after it (resumed from outside, never moved). */
export function atScanFor(status: string, last: ArmMarker | null, prev: ArmMarker | null, cart: number): boolean {
	if (status !== 'paused' || !last || !last.paused) return false;
	if (last.kind === 'AT_SCAN' && last.cart === cart) return true;
	return last.kind === 'NO_INSTRUCTION' && last.cart === cart && prev?.kind === 'AT_SCAN' && prev.cart === cart;
}
