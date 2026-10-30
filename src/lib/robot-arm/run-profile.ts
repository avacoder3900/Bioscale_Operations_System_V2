/**
 * Fill profile of one OT-2 run on the robot-arm wax-fill line, built from the
 * run's own command log (GET /runs/{id}/commands): every command the engine
 * executed carries startedAt / completedAt, so the seconds of a fill can be
 * laid out per cart and per station without any extra instrumentation.
 *
 * Phases are cut at the protocol's `ARM PARKED <i>` pauses (ARM-WAX-LOOP-B):
 *   Start-up  = run start → the end of `ARM PARKED 1`  (home, tip, probe,
 *               first aspirate, then parked while the arm grabs cart 1)
 *   Cart i    = end of `ARM PARKED i` → end of `ARM PARKED i+1`  (scan move,
 *               AT_SCAN hold, the 12 holes, back to the tube, re-aspirate,
 *               then parked while the arm withdraws i and grabs i+1)
 *   Wind-down = the phase that drops the tip (end: tube, trash, home)
 *
 * Buckets inside a phase (seconds):
 *   lift        Z-only homes (the lift rule)
 *   tube        moves to and plunger work in the wax tube (labware commands)
 *   stage       bare-point moves near the taught cart and the in-place dispenses
 *   scan        bare-point moves near the taught scan position
 *   calibrator  bare-point moves near the tip calibrator
 *   tiprack / trash / home   pick-up, drop, all-axes homes
 *   delay       protocol.delay() waits
 *   parked      `ARM PARKED` pauses: the OT-2 idle in the wax, the arm's turn
 *   atScan      `ARM AT_SCAN` pauses: the gantry holding over the stage for the read
 *   otherPause  any other waitForResume (tip tracker, no-tip prompts, operator)
 *   gap         time between one command's end and the next one's start (engine)
 *   other       anything else (comments, loads, light changes)
 *
 * Pure: no I/O. $lib/server/arm-wax-fill-profile reads the robot and caches.
 */

export interface Ot2CommandSummary {
	id?: string;
	key?: string;
	commandType: string;
	status?: string;
	createdAt?: string | null;
	startedAt?: string | null;
	completedAt?: string | null;
	params?: Record<string, unknown> | null;
}

export interface XY {
	x: number;
	y: number;
}

/** Taught points from the run's run-time parameters, for classifying bare-point moves. */
export interface ProfileLandmarks {
	cart: XY | null;
	scan: XY | null;
	calibrator: XY | null;
}

export const PROFILE_BUCKETS = [
	'lift',
	'tube',
	'stage',
	'scan',
	'calibrator',
	'tiprack',
	'trash',
	'home',
	'delay',
	'parked',
	'atScan',
	'otherPause',
	'gap',
	'other'
] as const;
export type ProfileBucket = (typeof PROFILE_BUCKETS)[number];

export const BUCKET_LABEL: Record<ProfileBucket, string> = {
	lift: 'Lifts',
	tube: 'Tube',
	stage: 'Stage',
	scan: 'Scan move',
	calibrator: 'Calibrator',
	tiprack: 'Tip rack',
	trash: 'Trash',
	home: 'Home',
	delay: 'Delays',
	parked: 'Parked (arm)',
	atScan: 'At scan',
	otherPause: 'Other pauses',
	gap: 'Gaps',
	other: 'Other'
};

export interface ProfilePhase {
	label: string;
	/** The cart this phase fills (null for start-up and wind-down). */
	cart: number | null;
	/** 'filled' | 'skipped' | null — from the protocol's ARM CART comments. */
	outcome: 'filled' | 'skipped' | null;
	fromAt: string | null;
	toAt: string | null;
	totalS: number;
	buckets: Record<ProfileBucket, number>;
	counts: { commands: number; lifts: number; aspirates: number; holes: number; moves: number };
}

export interface RunProfile {
	runId: string;
	status: string | null;
	startedAt: string | null;
	completedAt: string | null;
	/** Run start → run end (or → the last command seen when the run is still going). */
	totalS: number | null;
	commandCount: number;
	phases: ProfilePhase[];
	notes: string[];
	generatedAt: string;
}

/** A bare-point move within this of a taught point (XY, mm) is "at" that station. */
export const LANDMARK_RADIUS_MM = 40;

const Z_AXES = new Set(['leftZ', 'rightZ', 'z', 'a', 'leftz', 'rightz']);

const ms = (iso: string | null | undefined): number | null => {
	if (!iso) return null;
	const t = new Date(iso).getTime();
	return Number.isFinite(t) ? t : null;
};

const emptyBuckets = (): Record<ProfileBucket, number> => {
	const b = {} as Record<ProfileBucket, number>;
	for (const k of PROFILE_BUCKETS) b[k] = 0;
	return b;
};

function newPhase(label: string, cart: number | null, fromAt: string | null): ProfilePhase {
	return { label, cart, outcome: null, fromAt, toAt: null, totalS: 0, buckets: emptyBuckets(), counts: { commands: 0, lifts: 0, aspirates: 0, holes: 0, moves: 0 } };
}

const PARKED_RE = /^\s*ARM\s+PARKED\s+(\d+)\b/i;
const AT_SCAN_RE = /^\s*ARM\s+AT_SCAN\s+(\d+)\b/i;
const NO_INSTRUCTION_RE = /^\s*ARM\s+NO_INSTRUCTION\s+(\d+)\b/i;
const CART_RE = /^\s*ARM\s+CART\s+(\d+)\s+(FILLED|SKIPPED)\b/i;

function messageOf(c: Ot2CommandSummary): string {
	const m = (c.params as { message?: unknown } | null)?.message;
	return typeof m === 'string' ? m : '';
}

function pointOf(c: Ot2CommandSummary): XY | null {
	const p = (c.params as { coordinates?: { x?: unknown; y?: unknown } } | null)?.coordinates;
	const x = Number(p?.x);
	const y = Number(p?.y);
	return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/** Which taught point a bare-point move is nearest to, within LANDMARK_RADIUS_MM; 'stage' when nothing is taught. */
export function classifyPoint(p: XY | null, lm: ProfileLandmarks | undefined): 'stage' | 'scan' | 'calibrator' {
	if (!p || !lm) return 'stage';
	let best: { kind: 'stage' | 'scan' | 'calibrator'; d: number } | null = null;
	const consider = (kind: 'stage' | 'scan' | 'calibrator', at: XY | null) => {
		if (!at) return;
		const d = Math.hypot(p.x - at.x, p.y - at.y);
		if (!best || d < best.d) best = { kind, d };
	};
	consider('stage', lm.cart);
	consider('scan', lm.scan);
	consider('calibrator', lm.calibrator);
	const b = best as { kind: 'stage' | 'scan' | 'calibrator'; d: number } | null;
	if (!b) return 'stage';
	return b.d <= LANDMARK_RADIUS_MM ? b.kind : 'stage';
}

export function profileRun(
	runId: string,
	commands: Ot2CommandSummary[],
	opts: { status?: string | null; startedAt?: string | null; completedAt?: string | null; landmarks?: ProfileLandmarks } = {}
): RunProfile {
	const notes: string[] = [];
	const phases: ProfilePhase[] = [];
	let phase = newPhase('Start-up', null, opts.startedAt ?? null);
	phases.push(phase);
	// Where the pipette is for in-place plunger work and unknown commands.
	let station: ProfileBucket = 'other';
	let lastPause: 'parked' | 'atScan' | null = null;
	let prevEnd: number | null = null;
	let lastSeen: number | null = null;
	let unclassified = 0;

	const add = (bucket: ProfileBucket, s: number) => {
		phase.buckets[bucket] += s;
	};

	for (const c of commands) {
		const start = ms(c.startedAt);
		const end = ms(c.completedAt);
		if (start == null) continue; // never ran (queued, or an analysis stub)
		const dur = end != null && end > start ? (end - start) / 1000 : 0;
		if (prevEnd != null && start > prevEnd) add('gap', (start - prevEnd) / 1000);
		if (end != null) prevEnd = Math.max(prevEnd ?? 0, end);
		lastSeen = Math.max(lastSeen ?? 0, end ?? start);
		if (!phase.fromAt) phase.fromAt = c.startedAt ?? null;
		phase.counts.commands += 1;

		const type = c.commandType;
		const params = (c.params ?? {}) as Record<string, unknown>;
		const hasLabware = typeof params.labwareId === 'string' && params.labwareId.length > 0;

		switch (type) {
			case 'home': {
				const axes = Array.isArray(params.axes) ? (params.axes as unknown[]).map(String) : [];
				if (axes.length && axes.every((a) => Z_AXES.has(a))) {
					add('lift', dur);
					phase.counts.lifts += 1;
				} else {
					add('home', dur);
					station = 'home';
				}
				break;
			}
			case 'waitForResume': {
				const msg = messageOf(c);
				const parked = msg.match(PARKED_RE);
				const atScan = msg.match(AT_SCAN_RE);
				const noInstr = msg.match(NO_INSTRUCTION_RE);
				if (parked) {
					add('parked', dur);
					lastPause = 'parked';
					// The pause ended: the protocol resumed into the next cart's work.
					phase.toAt = c.completedAt ?? null;
					const cart = Number(parked[1]);
					phase = newPhase(`Cart ${cart}`, cart, c.completedAt ?? null);
					phases.push(phase);
					prevEnd = end;
				} else if (atScan) {
					add('atScan', dur);
					lastPause = 'atScan';
				} else if (noInstr) {
					add(lastPause ?? 'otherPause', dur);
					notes.push(`${msg.trim()}: the run was resumed without an instruction and waited again (${dur.toFixed(1)} s counted as ${lastPause ?? 'another pause'}).`);
				} else {
					add('otherPause', dur);
					if (msg.trim()) notes.push(`Pause "${msg.trim().slice(0, 80)}" held the run ${dur.toFixed(1)} s.`);
				}
				break;
			}
			case 'waitForDuration':
				add('delay', dur);
				break;
			case 'pickUpTip':
				add('tiprack', dur);
				station = 'tiprack';
				break;
			case 'dropTip':
			case 'dropTipInPlace':
				add('trash', dur);
				station = 'trash';
				if (phase.cart != null) phase.label = 'Wind-down';
				break;
			case 'moveToCoordinates': {
				const kind = classifyPoint(pointOf(c), opts.landmarks);
				add(kind, dur);
				station = kind;
				phase.counts.moves += 1;
				break;
			}
			case 'moveToWell':
			case 'moveRelative':
			case 'moveToAddressableArea':
			case 'moveToAddressableAreaForDropTip':
				add(hasLabware || type !== 'moveRelative' ? 'tube' : station, dur);
				if (hasLabware) station = 'tube';
				phase.counts.moves += 1;
				break;
			case 'aspirate':
				add(hasLabware ? 'tube' : station, dur);
				if (hasLabware) station = 'tube';
				phase.counts.aspirates += 1;
				break;
			case 'aspirateInPlace':
				add(station === 'other' ? 'tube' : station, dur);
				phase.counts.aspirates += 1;
				break;
			case 'dispense':
				if (hasLabware) {
					add('tube', dur);
					station = 'tube';
				} else {
					add('stage', dur);
					phase.counts.holes += 1;
				}
				break;
			case 'dispenseInPlace':
				if (station === 'stage') {
					add('stage', dur);
					phase.counts.holes += 1;
				} else {
					add(station === 'other' ? 'tube' : station, dur);
				}
				break;
			case 'blowOut':
			case 'blowOutInPlace':
			case 'touchTip':
			case 'prepareToAspirate':
				add(hasLabware ? 'tube' : station === 'other' ? 'tube' : station, dur);
				if (hasLabware) station = 'tube';
				break;
			case 'comment': {
				const m = messageOf(c).match(CART_RE);
				if (m) {
					const cart = Number(m[1]);
					const outcome = m[2].toUpperCase() === 'FILLED' ? 'filled' : 'skipped';
					const target = phases.find((p) => p.cart === cart) ?? phase;
					target.outcome = outcome;
					if (outcome === 'skipped') target.label = `Cart ${cart} (skipped)`;
				}
				add('other', dur);
				break;
			}
			default:
				add('other', dur);
				if (dur > 0.5) unclassified += 1;
		}
	}

	// Close the last phase on whatever ended last.
	const lastIso = lastSeen != null ? new Date(lastSeen).toISOString() : null;
	if (!phase.toAt) phase.toAt = opts.completedAt ?? lastIso;
	for (const p of phases) {
		const a = ms(p.fromAt);
		const b = ms(p.toAt);
		p.totalS = a != null && b != null && b > a ? (b - a) / 1000 : PROFILE_BUCKETS.reduce((s, k) => s + p.buckets[k], 0);
		for (const k of PROFILE_BUCKETS) p.buckets[k] = Math.round(p.buckets[k] * 100) / 100;
		p.totalS = Math.round(p.totalS * 100) / 100;
	}
	// An empty trailing phase (the run ended right at a park) says nothing.
	const kept = phases.filter((p, i) => i === 0 || p.counts.commands > 0);

	if (!opts.landmarks || (!opts.landmarks.cart && !opts.landmarks.scan && !opts.landmarks.calibrator)) {
		notes.push('No taught points came with the run (arm_cart / arm_scan / cal_x,y), so every bare-point move counts as "Stage".');
	}
	if (unclassified) notes.push(`${unclassified} command(s) of an unexpected type took over 0.5 s and are counted under "Other".`);
	if (kept.length === 1) notes.push('The run never reached ARM PARKED 1: everything is start-up.');

	const startMs = ms(opts.startedAt);
	const endMs = ms(opts.completedAt) ?? lastSeen;
	return {
		runId,
		status: opts.status ?? null,
		startedAt: opts.startedAt ?? null,
		completedAt: opts.completedAt ?? null,
		totalS: startMs != null && endMs != null && endMs > startMs ? Math.round(((endMs - startMs) / 1000) * 100) / 100 : null,
		commandCount: commands.length,
		phases: kept,
		notes,
		generatedAt: new Date().toISOString()
	};
}
