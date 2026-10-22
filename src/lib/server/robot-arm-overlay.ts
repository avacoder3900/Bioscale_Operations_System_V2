/**
 * Overlay (Clean-up tab) — server side. The pilot's positions on an animated
 * recording; the maths is in src/lib/robot-arm/recording-overlay.ts.
 *
 * Nothing is stored for a preview: the page reads both recordings off the Pi
 * and hands the browser both sets of frames; the alignment (stretch or
 * follow) and the settings (strength, window, servos, cap) are applied there
 * from the same pure module, without a round trip. Saving reads the Pi again
 * and recomputes with the settings sent — both alignments are
 * deterministic, so what was on screen is what gets written.
 *
 * Two ways out: a NEW recording on the Pi (the animated recording's timing
 * and curves with the pilot's positions), or a clean-up draft whose frames
 * are the overlay, so it can be split into steps and sent to Animate like any
 * recording.
 */
import { AuditLog, generateId } from '$lib/server/db';
import { robotArm, type RecordingMeta, type RecordingSidecar } from '$lib/server/robot-arm-client';
import {
	CleanupError,
	cleanSplit,
	insertCleanup,
	readSourceRecording,
	type CleanupOverlayInfo,
	type SourceRecording
} from '$lib/server/robot-arm-cleanup';
import { cleanRecordingName } from '$lib/robot-arm/recording-cleanup';
import { validateSmoothOptions } from '$lib/robot-arm/recording-smooth';
import {
	alignWith,
	applyOverlay,
	composeOverlayRecording,
	validateOverlayOptions,
	type OverlayOptions,
	type ServoSummary
} from '$lib/robot-arm/recording-overlay';

interface User {
	_id: string;
	username: string;
}

/** Frames the browser is given to preview, per recording; a longer one is refused (600 s at 30 Hz is the Animate limit anyway). */
const MAX_PREVIEW_FRAMES = 20000;

export type RecordingKind = 'animated' | 'teleop' | 'cleaned' | 'overlay' | 'other';

export interface RecordingChoice {
	name: string;
	kind: RecordingKind;
	modified: string;
	sizeBytes: number;
	/** What made it: the move set / clean-up / run step, for the picker. */
	from: string | null;
}

/** What a recording on the Pi is, from its sidecar (the Animate tab, clean-ups and this overlay all tag theirs). */
export function classifyRecording(r: RecordingMeta): RecordingChoice {
	const m = (r.meta ?? {}) as RecordingSidecar & Record<string, unknown>;
	let kind: RecordingKind = 'other';
	let from: string | null = null;
	if (typeof m.overlaid_from === 'string') {
		kind = 'overlay';
		from = `${m.overlaid_from} + ${String(m.position_reference ?? '?')}`;
	} else if (typeof m.animated === 'string') {
		kind = 'animated';
		from = m.animated;
	} else if (typeof m.cleaned_from === 'string') {
		kind = 'cleaned';
		from = m.cleaned_from;
	} else if (m.manufacturing_step || m.recorded_during_run_id || m.run_id || m.lot_id) {
		kind = 'teleop';
		from = typeof m.manufacturing_step === 'string' ? m.manufacturing_step : null;
	}
	return { name: r.name, kind, modified: r.modified, sizeBytes: r.size_bytes, from };
}

export async function listRecordingChoices(): Promise<{ recordings: RecordingChoice[]; error: string | null }> {
	try {
		const r = await robotArm.listRecordings();
		const list = r.recordings.map(classifyRecording).sort((a, b) => b.modified.localeCompare(a.modified));
		return { recordings: list, error: null };
	} catch (err) {
		return { recordings: [], error: (err as Error).message };
	}
}

export interface OverlayPreview {
	smooth: { name: string; frames: number; durationS: number; rateHz: number; jointNames: string[]; animated: string | null };
	precise: { name: string; frames: number; durationS: number };
	/** The animated recording's frames. */
	t: number[];
	goal: number[][];
	/** The pilot's recording's frames (lined up in the browser, alignWith). */
	pilotT: number[];
	pilotGoal: number[][];
}

function pair(smoothName: string, preciseName: string) {
	if (!smoothName || !preciseName) throw new CleanupError('Pick an animated recording and a pilot recording.');
	if (smoothName === preciseName) throw new CleanupError('Pick two different recordings.');
}

async function readBoth(smoothName: string, preciseName: string): Promise<{ smooth: SourceRecording; precise: SourceRecording }> {
	pair(smoothName, preciseName);
	const [smooth, precise] = await Promise.all([readSourceRecording(smoothName), readSourceRecording(preciseName)]);
	for (const r of [smooth, precise]) {
		if (r.rawT.length > MAX_PREVIEW_FRAMES) {
			throw new CleanupError(`"${r.name}" has ${r.rawT.length} frames; the overlay handles up to ${MAX_PREVIEW_FRAMES}.`);
		}
	}
	return { smooth, precise };
}

function align(smooth: SourceRecording, precise: SourceRecording, options: OverlayOptions) {
	try {
		return alignWith({ t: smooth.rawT, goal: smooth.rawGoal }, { t: precise.rawT, goal: precise.rawGoal }, options);
	} catch (err) {
		throw new CleanupError(`Could not line the recordings up: ${(err as Error).message}`);
	}
}

/** Both recordings read, for the page to line up. */
export async function previewOverlay(smoothName: string, preciseName: string): Promise<OverlayPreview> {
	const { smooth, precise } = await readBoth(smoothName, preciseName);
	const header = (smooth.header ?? {}) as Record<string, unknown>;
	return JSON.parse(
		JSON.stringify({
			smooth: {
				name: smooth.name,
				frames: smooth.rawT.length,
				durationS: smooth.rawT[smooth.rawT.length - 1] - smooth.rawT[0],
				rateHz: smooth.rateHz,
				jointNames: smooth.jointNames,
				animated: typeof header.animated === 'string' ? header.animated : null
			},
			precise: {
				name: precise.name,
				frames: precise.rawT.length,
				durationS: precise.rawT[precise.rawT.length - 1] - precise.rawT[0]
			},
			t: smooth.rawT,
			goal: smooth.rawGoal,
			pilotT: precise.rawT,
			pilotGoal: precise.rawGoal
		})
	);
}

function parseOptions(raw: string): OverlayOptions {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : {};
	} catch {
		throw new CleanupError('The page sent unreadable settings. Reload it.');
	}
	try {
		return validateOverlayOptions(parsed);
	} catch (err) {
		throw new CleanupError((err as Error).message);
	}
}

async function compute(smoothName: string, preciseName: string, rawOptions: string) {
	const options = parseOptions(rawOptions);
	const { smooth, precise } = await readBoth(smoothName, preciseName);
	const a = align(smooth, precise, options);
	const result = applyOverlay({ t: smooth.rawT, goal: smooth.rawGoal }, a, options);
	return { options, smooth, precise, fit: Math.round(a.fit * 10) / 10, result };
}

export interface OverlaySaved {
	name: string;
	frames: number;
	durationS: number;
	fit: number;
	servos: ServoSummary[];
}

/** Write the overlay to the Pi as a new recording. */
export async function saveOverlayToPi(
	user: User,
	o: { smoothName: string; preciseName: string; options: string; name: string }
): Promise<OverlaySaved> {
	const name = cleanRecordingName(o.name);
	if (!name) throw new CleanupError('Name: letters, numbers, spaces, - _ . only (max 100).');
	const { options, smooth, precise, fit, result } = await compute(o.smoothName, o.preciseName, o.options);
	const now = new Date();
	const out = composeOverlayRecording(smooth.rawT, result.goal, {
		smoothHeader: smooth.header,
		smoothName: smooth.name,
		preciseName: precise.name,
		options,
		jointNames: smooth.jointNames,
		rateHz: smooth.rateHz,
		now
	});
	// Extra keys ride along in the Pi's sidecar so the recording says where it came from (classifyRecording reads them back).
	const meta: RecordingSidecar & Record<string, unknown> = {
		schema_version: 1,
		frame_count: out.frames,
		operator: user.username,
		started_at_iso: now.toISOString(),
		rate_hz: smooth.rateHz,
		overlaid_from: smooth.name,
		position_reference: precise.name,
		overlay: { ...options, fit }
	};
	try {
		await robotArm.restoreRecording({ name, jsonl: out.jsonl, meta });
	} catch (err) {
		const msg = (err as Error).message ?? '';
		if (msg.includes('robot-arm 409')) throw new CleanupError(`"${name}" already exists on the Pi. Pick another name.`, 409);
		throw new CleanupError(`The Pi did not take the recording: ${msg}`, 502);
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'robot_arm_recordings',
		recordId: `${name}.jsonl`,
		action: 'robot_arm.cleanup.overlay_save_to_pi',
		newData: {
			userId: user._id,
			name: `${name}.jsonl`,
			animated: smooth.name,
			pilot: precise.name,
			...options,
			fit,
			frames: out.frames,
			durationS: out.durationS,
			servos: result.servos
		},
		changedBy: user.username
	});
	return { name: `${name}.jsonl`, frames: out.frames, durationS: out.durationS, fit, servos: result.servos };
}

/** The overlay as a new clean-up draft (split into steps like any recording). Returns the draft id. */
export async function overlayToCleanup(
	user: User,
	o: { smoothName: string; preciseName: string; options: string; thresholdSteps: unknown; pauseS: unknown }
): Promise<string> {
	const split = cleanSplit(o.thresholdSteps, o.pauseS);
	const { options, smooth, precise, fit, result } = await compute(o.smoothName, o.preciseName, o.options);
	const overlay: CleanupOverlayInfo = { ...options, preciseName: precise.name, fit };
	const source: SourceRecording = {
		...smooth,
		header: { ...(smooth.header ?? {}), overlay: { animated: smooth.name, pilot: precise.name, ...options } },
		rawGoal: result.goal
	};
	const stem = (n: string) => n.replace(/\.jsonl$/i, '');
	// Smoothing on from the recording, so the clean-up's Save to Pi keeps the overlay's curves (steps would be straight lines).
	return insertCleanup(user, {
		source,
		split,
		overlay,
		title: `${stem(smooth.name)} + ${stem(precise.name)}`,
		smoothing: validateSmoothOptions({})
	});
}
