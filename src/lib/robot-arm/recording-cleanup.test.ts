import { describe, it, expect } from 'vitest';
import {
	cleanRecordingName,
	composeRecording,
	draftFromSteps,
	draftToAnimation,
	resolveSteps,
	validateDraft,
	type CleanDraft
} from './recording-cleanup';
import { parseRecording, recordingToSteps, type RecordingFrame } from './recording-steps';
import { buildPath, cleanKeyframes, minDurationS, pathStats, tooFast, MAX_STEPS_PER_S, type ResolvedKeyframe } from './animation';

const START = { '1': 2000, '2': 900, '3': 3000, '4': 900, '5': 2000, '6': 2100 };

function draft(): CleanDraft {
	return {
		start: { ...START },
		steps: [
			{ id: 'a', label: 'reach', durationS: 1, pauseAfterS: 0, raw: null, moves: [{ servoId: 1, to: 2300, raw: null }, { servoId: 2, to: 800, raw: null }] },
			{ id: 'b', label: '', durationS: 0.5, pauseAfterS: 0.2, raw: null, moves: [{ servoId: 1, to: 2200, raw: null }] }
		]
	};
}

describe('resolveSteps', () => {
	it('chains each move from where the previous steps left its servo', () => {
		const r = resolveSteps(draft());
		expect(r.steps[0].moves[0]).toMatchObject({ servoId: 1, from: 2000, to: 2300, delta: 300 });
		expect(r.steps[1].moves[0]).toMatchObject({ servoId: 1, from: 2300, to: 2200, delta: -100 });
		expect(r.steps[1].before['2']).toBe(800);
		expect(r.steps[1].tStart).toBe(1);
		expect(r.durationS).toBeCloseTo(1.7);
		expect(r.end).toMatchObject({ '1': 2200, '2': 800, '6': 2100 });
	});
});

describe('composeRecording', () => {
	const header = {
		event: 'header',
		version: '1',
		rate_hz: 30,
		joint_names: ['a', 'b', 'c', 'd', 'e', 'f'],
		follower_neutral: [1, 1, 1, 1, 1, 1],
		follower_min: [0, 0, 0, 0, 0, 0],
		follower_max: [4095, 4095, 4095, 4095, 4095, 4095],
		scale: [1, 1, 1, 1, 1, 1]
	};

	it('writes header (start pose as neutral), linear frames per step, holds, footer', () => {
		const out = composeRecording(draft(), { sourceHeader: header, sourceName: 'src.jsonl', rateHz: 30 });
		const lines = out.jsonl.trim().split('\n').map((l) => JSON.parse(l));
		const head = lines[0];
		expect(head.event).toBe('header');
		expect(head.follower_neutral).toEqual([2000, 900, 3000, 900, 2000, 2100]);
		expect(head.cleaned_from).toBe('src.jsonl');
		expect(head.scale).toEqual([1, 1, 1, 1, 1, 1]);

		const frames = lines.filter((l) => l.event === 'frame');
		// 1 start + 30 (step 1) + 15 (step 2) + 6 (pause)
		expect(frames).toHaveLength(52);
		expect(out.frames).toBe(52);
		expect(frames[0]).toMatchObject({ t: 0, step: 0, goal: [2000, 900, 3000, 900, 2000, 2100] });
		expect(frames[15].goal[0]).toBe(2150);
		expect(frames[30]).toMatchObject({ step: 1, goal: [2300, 800, 3000, 900, 2000, 2100] });
		expect(frames[45].goal[0]).toBe(2200);
		expect(frames[51]).toMatchObject({ step: 2, goal: [2200, 800, 3000, 900, 2000, 2100] });
		// Servos not in a step never change.
		expect(new Set(frames.map((f) => f.goal[5]))).toEqual(new Set([2100]));
		// Even spacing at the rate.
		expect(frames[30].t).toBeCloseTo(1, 4);
		const footer = lines[lines.length - 1];
		expect(footer).toMatchObject({ event: 'footer', frames: 52 });
		expect(footer.duration_s).toBeCloseTo(51 / 30, 3);
	});

	it('clamps targets to the follower limits in the source header', () => {
		const d = draft();
		d.steps[0].moves[0].to = 4000;
		const out = composeRecording(d, {
			sourceHeader: { ...header, follower_max: [3317, 4095, 4095, 4095, 4095, 4095] },
			sourceName: 'x',
			rateHz: 30
		});
		const frames = out.jsonl.trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.event === 'frame');
		expect(Math.max(...frames.map((f) => f.goal[0]))).toBe(3317);
	});

	it('round-trips through parseRecording', () => {
		const out = composeRecording(draft(), { sourceHeader: header, sourceName: 'x', rateHz: 30 });
		const parsed = parseRecording(out.jsonl);
		expect(parsed.header?.rateHz).toBe(30);
		expect(parsed.frames[parsed.frames.length - 1].positions['1']).toBe(2200);
	});
});

describe('draftFromSteps', () => {
	it('keeps raw targets and raw durations (to 0.1 s); the last step has no pause', () => {
		const f: RecordingFrame[] = Array.from({ length: 60 }, (_, i) => ({
			t: i / 30,
			positions: { '1': i < 10 ? 2000 : i < 40 ? 2000 + (i - 9) * 10 : 2300, '2': 900 }
		}));
		const d = draftFromSteps(recordingToSteps(f, { thresholdSteps: 5 }));
		expect(d.start).toEqual({ '1': 2000, '2': 900 });
		expect(d.steps).toHaveLength(1);
		expect(d.steps[0].moves).toEqual([{ servoId: 1, to: 2300, raw: { from: 2000, to: 2300 } }]);
		expect(d.steps[0].durationS).toBe(1);
		expect(d.steps[0].pauseAfterS).toBe(0);
	});
});

describe('validateDraft', () => {
	it('accepts a good draft and sorts moves by servo', () => {
		const d = draft();
		d.steps[0].moves.reverse();
		expect(validateDraft(JSON.parse(JSON.stringify(d))).steps[0].moves.map((m) => m.servoId)).toEqual([1, 2]);
	});

	it.each([
		['a duplicate servo in a step', (d: CleanDraft) => d.steps[0].moves.push({ servoId: 1, to: 1, raw: null }), /twice/],
		['an out-of-range position', (d: CleanDraft) => (d.steps[1].moves[0].to = 5000), /0–4095/],
		['a fractional position', (d: CleanDraft) => (d.steps[1].moves[0].to = 10.5), /whole number/],
		['a zero duration', (d: CleanDraft) => (d.steps[0].durationS = 0), /duration/],
		['an unknown servo', (d: CleanDraft) => (d.steps[0].moves[0].servoId = 7), /unknown servo/]
	])('rejects %s', (_name, mutate, msg) => {
		const d = draft();
		mutate(d);
		expect(() => validateDraft(d)).toThrow(msg);
	});
});

describe('cleanRecordingName', () => {
	it('accepts tidy names and strips .jsonl', () => {
		expect(cleanRecordingName(' Pick cartridge-clean.jsonl ')).toBe('Pick cartridge-clean');
	});
	it.each(['', '../x', 'a/b', '.hidden', 'x'.repeat(101)])('rejects %j', (n) => {
		expect(cleanRecordingName(n)).toBeNull();
	});
});

describe('draftFromSteps timing', () => {
	it('keeps the recorded idle time between steps as the pause', () => {
		const pos = (i: number) => (i < 10 ? 2000 : i < 20 ? 2000 + (i - 9) * 20 : i < 50 ? 2200 : i < 60 ? 2200 - (i - 49) * 20 : 2000);
		const f: RecordingFrame[] = Array.from({ length: 90 }, (_, i) => ({ t: i / 30, positions: { '1': pos(i) } }));
		const d = draftFromSteps(recordingToSteps(f, { thresholdSteps: 5 }));
		expect(d.steps).toHaveLength(2);
		expect(d.steps[0].pauseAfterS).toBeCloseTo(d.steps[1].raw!.tStart - d.steps[0].raw!.tEnd, 1);
		expect(d.steps[0].pauseAfterS).toBeGreaterThan(0.5);
		expect(d.steps[1].pauseAfterS).toBe(0);
	});
});

describe('draftToAnimation', () => {
	it('makes the start pose plus one pose per step, at the step end for every servo', () => {
		const a = draftToAnimation(draft());
		expect(a.poses.map((p) => p.label)).toEqual(['start', 'step 1 reach', 'step 2']);
		expect(a.poses[0].positions).toEqual([2000, 900, 3000, 900, 2000, 2100]);
		expect(a.poses[1].positions).toEqual([2300, 800, 3000, 900, 2000, 2100]);
		// Servo 2 was not in step 2: it holds where step 1 left it.
		expect(a.poses[2].positions).toEqual([2200, 800, 3000, 900, 2000, 2100]);
		expect(a.poses.map((p) => p.step)).toEqual([0, 1, 2]);
	});

	it('copies each step time and pause into the keyframe duration and hold, easy ease by default', () => {
		const a = draftToAnimation(draft());
		expect(a.keyframes.map((k) => k.pose)).toEqual([0, 1, 2]);
		expect(a.keyframes[1]).toMatchObject({ durationS: 1, holdS: 0, easing: 'ease' });
		expect(a.keyframes[2]).toMatchObject({ durationS: 0.5, holdS: 0.2, easing: 'ease' });
		expect(a.folded).toEqual([]);
		expect(a.lengthened).toEqual([]);
		// What the server stores passes the Animate tab's own validation.
		expect(() => cleanKeyframes(a.keyframes.map((k) => ({ ...k, poseId: `p${k.pose}` })))).not.toThrow();
	});

	it('uses the easing asked for and falls back to easy ease for an unknown one', () => {
		expect(draftToAnimation(draft(), { easing: 'flow' }).keyframes.every((k) => k.easing === 'flow')).toBe(true);
		expect(draftToAnimation(draft(), { easing: 'bouncy' }).keyframes[1].easing).toBe('ease');
	});

	it('lengthens a step the arm cannot do in its time, and the rendered path then stays under the speed limit', () => {
		const d = draft();
		d.steps[0] = { id: 'fast', label: '', durationS: 0.1, pauseAfterS: 0, raw: null, moves: [{ servoId: 1, to: 3500, raw: null }] };
		for (const easing of ['ease', 'linear', 'in'] as const) {
			const a = draftToAnimation(d, { easing });
			const min = minDurationS(a.poses[0].positions, a.poses[1].positions, MAX_STEPS_PER_S, easing);
			expect(min).toBeGreaterThan(0.1);
			expect(a.keyframes[1].durationS).toBe(min);
			// Step 2 then brings servo 1 back 1300 steps in 0.5 s, which is also too fast.
			expect(a.lengthened).toEqual([1, 2]);
			expect(a.keyframes[2].durationS).toBe(minDurationS(a.poses[1].positions, a.poses[2].positions, MAX_STEPS_PER_S, easing));
			const resolved: ResolvedKeyframe[] = a.keyframes.map((k) => ({ ...k, poseId: `p${k.pose}`, name: a.poses[k.pose].label, positions: a.poses[k.pose].positions }));
			expect(pathStats(buildPath(resolved)).tooFast).toEqual([]);
			expect(tooFast(resolved)).toEqual([]);
		}
	});

	it('folds a step that moves nothing into the previous hold instead of making a pose', () => {
		const d = draft();
		d.steps.splice(1, 0, { id: 'wait', label: 'settle', durationS: 1, pauseAfterS: 0.5, raw: null, moves: [] });
		const a = draftToAnimation(d);
		expect(a.poses).toHaveLength(3);
		expect(a.folded).toEqual([2]);
		expect(a.keyframes[1].holdS).toBeCloseTo(1.5, 9);
		expect(a.poses[2].label).toBe('step 3');
	});

	it('refuses a draft with no steps or without a full start pose', () => {
		expect(() => draftToAnimation({ start: { ...START }, steps: [] })).toThrow(/no steps/);
		const d = draft();
		delete d.start['3'];
		expect(() => draftToAnimation(d)).toThrow(/servo 3/);
	});
});
