/**
 * Tip-break recovery for the wax/reagent fill runs.
 *
 * When a tip snaps mid-fill the operator used to re-run the whole deck. The OT-2 can't be
 * told to jump mid-run (pause/stop is all it offers, and its native error recovery only
 * engages on a command the ROBOT detects as failed — a snapped tip isn't one), so recovery
 * is: stop the run, eject the broken tip, start a FRESH run that skips to where the old one
 * died. The protocols take resume_cartridge / resume_hole (+ resume_reagent) for that.
 *
 * This module answers the one question BIMS needs: WHERE did the aborted run get to?
 *
 * It reads the breadcrumb the protocols emit after every dispense —
 *   FILL PROGRESS: group=<g> cartridge=<n> hole=<n> well=<name>
 * — rather than re-deriving the well order in TypeScript. That ordering is genuinely
 * awkward (it serpentines; wax groups columns in fours; reagent differs per group), and a
 * TS copy of it would rot the moment either side moved. The protocol is the single source
 * of truth for where the pipette actually was.
 */
import { robotGet } from './proxy';

export type RobotRef = { ip: string; port?: number | null };

export interface FillProgress {
	/** Reagent group whose tip was in use ('wax' for the wax protocol). */
	group: string;
	/** 1-based, as the operator counts them on the bench. */
	cartridge: number;
	hole: number;
	/** Deck well name, e.g. 'X2' — for display only. */
	well: string;
	/** How many wells the run got through (all groups). Display only. */
	wellsFilled: number;
}

const BREADCRUMB =
	/FILL PROGRESS:\s*group=(\S+)\s+cartridge=(\d+)\s+hole=(\d+)\s+well=(\S+)/;

/**
 * The last well that actually received liquid in this run, or null if it died before
 * dispensing anything (in which case there is nothing to resume — just re-run it).
 *
 * The breadcrumb is emitted AFTER the dispense, so the last one we see is the last well
 * that got liquid. We hand that same well back as the resume point rather than the one
 * after it: when a tip breaks, the well it was over is exactly the one you cannot trust,
 * so it gets re-done. Erring toward re-dispensing one well is much cheaper than leaving a
 * gap in the deck.
 */
export async function readFillProgress(
	robot: RobotRef,
	opentronsRunId: string
): Promise<FillProgress | null> {
	const res = await robotGet(
		robot as any,
		`/runs/${opentronsRunId}/commands?cursor=0&pageLength=10000`
	);
	if (!res.ok) return null;
	const body = await res.json().catch(() => null as any);
	const commands: any[] = body?.data ?? [];

	let last: FillProgress | null = null;
	let wellsFilled = 0;

	for (const cmd of commands) {
		// Only trust a breadcrumb whose command actually completed. A comment queued but
		// not executed (the run was stopped mid-flight) must not be read as progress.
		if (cmd?.commandType !== 'comment' || cmd?.status !== 'succeeded') continue;
		const m = BREADCRUMB.exec(String(cmd?.params?.message ?? ''));
		if (!m) continue;
		wellsFilled += 1;
		last = {
			group: m[1],
			cartridge: parseInt(m[2], 10),
			hole: parseInt(m[3], 10),
			well: m[4],
			wellsFilled
		};
	}
	return last;
}

/**
 * Turn a progress point into the runtime-parameter overrides for the resume run.
 * `kind` picks the protocol's parameter shape: wax has no reagent groups.
 */
export function resumeParamsFor(
	kind: 'wax' | 'reagent',
	progress: FillProgress
): Record<string, string | number> {
	const params: Record<string, string | number> = {
		resume_cartridge: progress.cartridge,
		resume_hole: progress.hole
	};
	if (kind === 'reagent') {
		// Which reagent's tip broke. Without this the protocol cannot tell "cartridge 24,
		// hole 3 of the tracer pass" from the same coordinates in the wash pass — each
		// reagent is a separate full sweep of the deck with its own tip.
		params.resume_reagent = progress.group;
	}
	return params;
}
