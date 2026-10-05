/**
 * The SONIC assay as a timeline (SONIC workflow, step 6).
 *
 * The device runs assay A78C7989's BCODE: 48 top-level steps, ≈ 299.7 s on the
 * firmware timing model. Every second of a verified recording can therefore be
 * read as "step N". The timing model is the Lambda's, as ported in
 * scripts/create-validation-assays.ts (READ SENSOR charged at its real ~0.5 s —
 * SONIC has none).
 *
 * Steps also carry their repeating parts, which the anomaly check compares with
 * each other ("is this repetition like its siblings?"):
 *   - REPEAT blocks → one part per repetition (e.g. 12 × "move 300 µm + wait");
 *   - SINUSOIDAL OSCILLATE → one part per cycle.
 */
export const SONIC_ASSAY_ID = 'A78C7989';
/** Shortest oscillation slice compared against its siblings. */
export const OSC_SLICE_MIN_S = 1;

export type StepKind = 'start' | 'finish' | 'move' | 'oscillate' | 'delay' | 'repeat' | 'other';

export interface TimelineStep {
	index: number; // 1-based, matches the BCODE's top-level order
	kind: StepKind;
	label: string;
	t0: number; // nominal seconds from the start of the run
	t1: number;
	/** Repeating parts inside the step (nominal seconds), for the sibling comparison. */
	parts: { t0: number; t1: number }[];
	/** True when the unit is moving (sound expected), false for waits. */
	moving: boolean;
	/**
	 * How loud this step is expected to be, 0..1 (alignment only): oscillations are
	 * the loudest, long moves next, the small 300 µm repeat moves barely above a wait.
	 */
	loudness: number;
	/** REPEAT only: one repetition's inner sequence, in nominal seconds, with each part's expected loudness. */
	pattern?: { d: number; loudness: number }[];
}

export interface Timeline {
	assayId: string;
	totalS: number;
	steps: TimelineStep[];
}

interface Block {
	command: string;
	params?: Record<string, any>;
	count?: number | string;
	code?: Block[];
}

export function stepMs(command: string, p: Record<string, any> = {}): number {
	switch (command.toUpperCase()) {
		case 'DELAY':
			return +p.delay_ms || 0;
		case 'MOVE MICRONS':
			return Math.floor((2 * Math.abs(+p.microns) * +p.step_delay_us) / 25000) || 0;
		case 'SINUSOIDAL OSCILLATE': {
			const m = Math.abs(+p.microns);
			const pd = +p.peak_delay_us;
			const sh = +p.shape_pct / 100;
			const c = +p.cycles;
			const n = Math.floor(m / 25);
			let s = 0;
			for (let i = 0; i < n; i++) s += 1 / Math.pow(Math.sin((Math.PI * (i + 0.5)) / n), sh);
			return Math.floor((pd * s * 2 * c) / 1000) || 0;
		}
		case 'READ SENSOR':
			return 500;
		case 'START TEST':
			return 9000;
		case 'FINISH TEST':
			return 8000;
	}
	return 0;
}

function blockMs(b: Block): number {
	if (b.command.toUpperCase() === 'REPEAT') return (b.code ?? []).reduce((d, x) => d + blockMs(x), 0) * (+(b.count ?? 0) || 0);
	return stepMs(b.command, b.params);
}

function kindOf(command: string): StepKind {
	switch (command.toUpperCase()) {
		case 'START TEST':
			return 'start';
		case 'FINISH TEST':
			return 'finish';
		case 'MOVE MICRONS':
			return 'move';
		case 'SINUSOIDAL OSCILLATE':
			return 'oscillate';
		case 'DELAY':
			return 'delay';
		case 'REPEAT':
			return 'repeat';
	}
	return 'other';
}

/** Expected loudness (0..1) of one block, for aligning the plan to a recording. */
function loudnessOf(b: Block): number {
	switch (kindOf(b.command)) {
		case 'oscillate':
			return 1;
		case 'move':
			return Math.abs(+(b.params?.microns ?? 0)) >= 1000 ? 0.75 : 0.45;
		case 'delay':
			return 0;
		case 'start':
		case 'finish':
			return 0.15;
		default:
			return 0.3;
	}
}

function labelOf(b: Block): string {
	const p = b.params ?? {};
	const comment = typeof p.comment === 'string' && p.comment.trim() ? ` — ${p.comment.trim()}` : '';
	switch (kindOf(b.command)) {
		case 'move':
			return `Move ${p.microns} µm${comment}`;
		case 'oscillate':
			return `Oscillate ${p.cycles} cycles${comment}`;
		case 'delay':
			return `Wait ${((+p.delay_ms || 0) / 1000).toFixed(1)} s${comment}`;
		case 'repeat': {
			const inner = (b.code ?? []).map((x) => (kindOf(x.command) === 'move' ? `move ${x.params?.microns} µm` : kindOf(x.command) === 'delay' ? `wait ${((+x.params?.delay_ms || 0) / 1000).toFixed(1)} s` : x.command.toLowerCase())).join(' + ');
			return `Repeat ${b.count}× (${inner})`;
		}
		default:
			return `${b.command}${comment}`;
	}
}

/** Build the timeline from an assay's BCODE.code (top-level steps). */
export function buildTimeline(code: Block[], assayId = SONIC_ASSAY_ID): Timeline {
	let t = 0;
	const steps: TimelineStep[] = code.map((b, i) => {
		const dur = blockMs(b) / 1000;
		const t0 = t;
		const t1 = t + dur;
		t = t1;
		const kind = kindOf(b.command);
		const parts: { t0: number; t1: number }[] = [];
		if (kind === 'repeat') {
			const n = +(b.count ?? 0) || 0;
			const each = n ? dur / n : 0;
			for (let k = 0; k < n; k++) parts.push({ t0: t0 + k * each, t1: t0 + (k + 1) * each });
		} else if (kind === 'oscillate') {
			// Cycles can be ~0.16 s (116 in 18 s) — a few spectrogram frames, too short
			// to compare. Group them into equal slices of at least ~1 s.
			const cycles = Math.max(1, Math.round(+(b.params?.cycles ?? 1)));
			const n = Math.max(1, Math.min(cycles, Math.floor(dur / OSC_SLICE_MIN_S)));
			const each = dur / n;
			for (let k = 0; k < n; k++) parts.push({ t0: t0 + k * each, t1: t0 + (k + 1) * each });
		}
		const pattern = kind === 'repeat' ? (b.code ?? []).map((x) => ({ d: blockMs(x) / 1000, loudness: loudnessOf(x) })) : undefined;
		return { index: i + 1, kind, label: labelOf(b), t0, t1, parts, moving: kind !== 'delay', loudness: loudnessOf(b), ...(pattern ? { pattern } : {}) };
	});
	return { assayId, totalS: t, steps };
}

/** Expected loudness (0..1) at nominal time `n` — repeats follow their inner move/wait pattern. */
export function expectedLoudness(tl: Timeline, n: number): number {
	const st = tl.steps.find((x) => n >= x.t0 && n < x.t1);
	if (!st) return 0;
	if (st.kind === 'repeat' && st.pattern?.length && st.parts.length) {
		const each = (st.t1 - st.t0) / st.parts.length;
		let pos = (n - st.t0) % each;
		for (const seg of st.pattern) {
			if (pos < seg.d) return seg.loudness;
			pos -= seg.d;
		}
		return 0;
	}
	return st.loudness;
}

/** Map a nominal timeline time to recording time, given the fitted offset and speed scale. */
export function toRecordingTime(nominalS: number, offsetS: number, scale: number): number {
	return offsetS + nominalS * scale;
}

/** Which step a recording time falls in (null outside the run). */
export function stepAt(tl: Timeline, recordingS: number, offsetS: number, scale: number): TimelineStep | null {
	const n = (recordingS - offsetS) / scale;
	if (n < 0 || n > tl.totalS) return null;
	return tl.steps.find((s) => n >= s.t0 && n < s.t1) ?? tl.steps[tl.steps.length - 1] ?? null;
}
