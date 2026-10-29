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
