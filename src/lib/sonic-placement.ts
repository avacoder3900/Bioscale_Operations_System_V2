/**
 * SONIC step placement (shared by the server and the review page, so an
 * operator's adjustments re-flow in the browser exactly as the server will
 * compute them).
 *
 * Landmarks are the steps that are unmistakably loud in a recording — the
 * oscillations and the long moves. Each has a start and end in recording time,
 * either ESTIMATED by the analysis or ADJUSTED by a person. Every other step is
 * placed between the landmarks around it, in proportion to its real (measured)
 * duration, so steps never stretch through silence. Before the first landmark /
 * after the last, steps keep their measured durations; a step that falls outside
 * the recording is marked so (the run was cut short) instead of being squeezed.
 */

export type StepKind = 'start' | 'finish' | 'move' | 'oscillate' | 'delay' | 'repeat' | 'other';

export interface PlanStep {
	index: number; // 1-based
	kind: StepKind;
	label: string;
	/** Modelled (firmware) seconds from the plan's start — the fixed coordinate system. */
	t0: number;
	t1: number;
	landmark: boolean;
	short: string; // e.g. "Osc W1", "Move −2000 µm"
}

export interface Landmark {
	step: number;
	t0: number; // recording seconds
	t1: number;
	source: 'estimate' | 'user';
	/** Estimates only: snapped to a detected loud stretch, or only predicted. */
	found?: boolean;
}

export interface PlacedStep {
	index: number;
	kind: StepKind;
	label: string;
	t0: number; // recording seconds
	t1: number;
	inRecording: boolean;
	landmark: boolean;
}

/** Oscillations of ≥ 1 s and moves of ≥ 1 mm are loud enough to find by ear and by level. */
export function isLandmarkStep(kind: StepKind, modelledS: number, microns: number | null): boolean {
	if (kind === 'oscillate') return modelledS >= 1;
	if (kind === 'move') return Math.abs(microns ?? 0) >= 1000;
	return false;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Place all steps given the landmarks. `durations[i]` is the real (measured)
 * duration of plan.steps[i] in seconds; it falls back to the modelled duration.
 */
export function placeSteps(
	plan: PlanStep[],
	durations: (number | null)[] | null,
	landmarks: Landmark[],
	recordingS: number
): PlacedStep[] {
	const n = plan.length;
	const dur = plan.map((s, i) => {
		const d = durations?.[i];
		return d != null && Number.isFinite(d) && d > 0 ? d : Math.max(0, s.t1 - s.t0);
	});
	const t0 = new Array<number>(n).fill(NaN);
	const t1 = new Array<number>(n).fill(NaN);
	// Landmarks in plan order, kept monotonic (a later landmark never starts before an earlier one ends).
	const lms = [...landmarks]
		.filter((l) => l.step >= 1 && l.step <= n && Number.isFinite(l.t0) && Number.isFinite(l.t1) && l.t1 > l.t0)
		.sort((a, b) => a.step - b.step);
	let floor = -Infinity;
	const anchors: { i: number; t0: number; t1: number }[] = [];
	for (const l of lms) {
		const a = Math.max(l.t0, floor);
		const b = Math.max(l.t1, a + 0.05);
		anchors.push({ i: l.step - 1, t0: a, t1: b });
		floor = b;
	}
	for (const a of anchors) {
		t0[a.i] = a.t0;
		t1[a.i] = a.t1;
	}
	if (!anchors.length) {
		// No landmark at all: lay the plan from the start of the recording at measured speed.
		let t = 0;
		for (let i = 0; i < n; i++) {
			t0[i] = t;
			t += dur[i];
			t1[i] = t;
		}
	} else {
		// Before the first landmark: back from it at measured durations.
		let t = anchors[0].t0;
		for (let i = anchors[0].i - 1; i >= 0; i--) {
			t1[i] = t;
			t -= dur[i];
			t0[i] = t;
		}
		// Between consecutive landmarks: the gap shared in proportion to measured durations.
		for (let k = 0; k < anchors.length - 1; k++) {
			const a = anchors[k];
			const b = anchors[k + 1];
			const ids: number[] = [];
			for (let i = a.i + 1; i < b.i; i++) ids.push(i);
			const want = ids.reduce((s, i) => s + dur[i], 0);
			const have = Math.max(0, b.t0 - a.t1);
			let cur = a.t1;
			for (const i of ids) {
				const d = want > 0 ? (dur[i] / want) * have : have / ids.length;
				t0[i] = cur;
				cur += d;
				t1[i] = cur;
			}
		}
		// After the last landmark: forward at measured durations.
		const last = anchors[anchors.length - 1];
		t = last.t1;
		for (let i = last.i + 1; i < n; i++) {
			t0[i] = t;
			t += dur[i];
			t1[i] = t;
		}
	}
	const lmSet = new Set(anchors.map((a) => a.i));
	return plan.map((s, i) => ({
		index: s.index,
		kind: s.kind,
		label: s.label,
		t0: r2(t0[i]),
		t1: r2(t1[i]),
		inRecording: t0[i] >= -0.5 && t1[i] <= recordingS + 0.5,
		landmark: lmSet.has(i) || s.landmark
	}));
}

/** Recording time of plan (modelled) time `n`, piecewise-linear through the placed steps. */
export function planToRecording(plan: PlanStep[], placed: PlacedStep[], n: number): number {
	if (!plan.length) return n;
	if (n <= plan[0].t0) return placed[0].t0 - (plan[0].t0 - n);
	for (let i = 0; i < plan.length; i++) {
		const p = plan[i];
		if (n < p.t1 || i === plan.length - 1) {
			const span = p.t1 - p.t0;
			const f = span > 0 ? Math.min(1, Math.max(0, (n - p.t0) / span)) : 0;
			const out = placed[i].t0 + f * (placed[i].t1 - placed[i].t0);
			if (i === plan.length - 1 && n > p.t1) return placed[i].t1 + (n - p.t1);
			return out;
		}
	}
	return n;
}
