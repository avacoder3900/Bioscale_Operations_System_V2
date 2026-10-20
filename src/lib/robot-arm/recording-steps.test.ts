import { describe, it, expect } from 'vitest';
import {
	detectMoves,
	groupIntoSteps,
	parseRecording,
	recordingToSteps,
	type RecordingFrame
} from './recording-steps';

const HZ = 30;

/** Build frames at 30 Hz from per-servo position tracks (same length). */
function frames(tracks: Record<number, number[]>): RecordingFrame[] {
	const n = Math.max(...Object.values(tracks).map((t) => t.length));
	return Array.from({ length: n }, (_, i) => ({
		t: i / HZ,
		positions: Object.fromEntries(Object.entries(tracks).map(([sid, t]) => [sid, t[Math.min(i, t.length - 1)]]))
	}));
}

const hold = (v: number, n: number) => Array(n).fill(v);
const ramp = (a: number, b: number, n: number) =>
	Array.from({ length: n }, (_, i) => Math.round(a + ((b - a) * (i + 1)) / n));

describe('detectMoves', () => {
	it('finds one move for a hold-ramp-hold track, with raw start and end positions', () => {
		const f = frames({ 1: [...hold(2000, 10), ...ramp(2000, 2300, 15), ...hold(2300, 10)] });
		const moves = detectMoves(f, 1, { thresholdSteps: 5 });
		expect(moves).toHaveLength(1);
		expect(moves[0]).toMatchObject({ servoId: 1, from: 2000, to: 2300, startFrame: 9, endFrame: 24 });
	});

	it('ignores changes at or below the threshold, but never alters the positions it reports', () => {
		const jitter = [2000, 2002, 1999, 2001, 2003, 1998, 2000, 2002];
		const f = frames({ 1: [...jitter, ...ramp(2000, 2200, 10), 2201, 2199, 2202] });
		const moves = detectMoves(f, 1, { thresholdSteps: 3 });
		expect(moves).toHaveLength(1);
		// Raw values: the move starts from the last settled raw reading, not a smoothed one.
		expect(f[moves[0].startFrame].positions['1']).toBe(moves[0].from);
		expect(moves[0].to).toBe(2200);
	});

	it('with threshold 0 counts every change, jitter included', () => {
		const f = frames({ 1: [2000, 2001, 2000, 2001, 2000] });
		// Every reversal is a new move: up, down, up, down.
		expect(detectMoves(f, 1, { thresholdSteps: 0 })).toHaveLength(4);
	});

	it('splits on a reversal', () => {
		const f = frames({ 1: [...hold(2000, 5), ...ramp(2000, 2200, 10), ...ramp(2200, 2050, 10), ...hold(2050, 5)] });
		const moves = detectMoves(f, 1, { thresholdSteps: 5 });
		expect(moves.map((m) => [m.from, m.to])).toEqual([
			[2000, 2200],
			[2200, 2050]
		]);
	});

	it('splits a same-direction move separated by a pause longer than pauseS', () => {
		const f = frames({ 1: [...hold(2000, 5), ...ramp(2000, 2100, 6), ...hold(2100, 15), ...ramp(2100, 2200, 6)] });
		expect(detectMoves(f, 1, { thresholdSteps: 5, pauseS: 0.25 })).toHaveLength(2);
		expect(detectMoves(f, 1, { thresholdSteps: 5, pauseS: 1 })).toHaveLength(1);
	});

	it('detects a slow sweep whose per-frame change is below the threshold', () => {
		const f = frames({ 1: [...hold(2000, 3), ...ramp(2000, 2060, 30), ...hold(2060, 3)] });
		const moves = detectMoves(f, 1, { thresholdSteps: 5 });
		expect(moves).toHaveLength(1);
		expect(moves[0].from).toBe(2000);
		expect(Math.abs(moves[0].to - 2060)).toBeLessThanOrEqual(5);
	});
});

describe('groupIntoSteps', () => {
	it('puts overlapping moves of different servos in one step', () => {
		const f = frames({
			1: [...hold(2000, 5), ...ramp(2000, 2300, 20), ...hold(2300, 20)],
			2: [...hold(1500, 10), ...ramp(1500, 1200, 20), ...hold(1200, 15)]
		});
		const { steps } = recordingToSteps(f, { thresholdSteps: 5 });
		expect(steps).toHaveLength(1);
		expect(steps[0].number).toBe(1);
		expect(steps[0].moves.map((m) => m.servoId)).toEqual([1, 2]);
	});

	it('keeps sequential moves in separate, numbered steps', () => {
		const f = frames({
			1: [...hold(2000, 5), ...ramp(2000, 2300, 10), ...hold(2300, 40)],
			2: [...hold(1500, 30), ...ramp(1500, 1200, 10), ...hold(1200, 15)]
		});
		const { steps } = recordingToSteps(f, { thresholdSteps: 5 });
		expect(steps.map((s) => [s.number, s.moves.map((m) => m.servoId)])).toEqual([
			[1, [1]],
			[2, [2]]
		]);
	});

	it('starts a new step when a servo already in the step moves again', () => {
		const base = { servoId: 1, from: 0, to: 1, startFrame: 0, endFrame: 0 };
		const steps = groupIntoSteps([
			{ ...base, tStart: 0, tEnd: 3 },
			{ ...base, servoId: 2, tStart: 1, tEnd: 5 },
			{ ...base, tStart: 4, tEnd: 6 }
		]);
		expect(steps.map((s) => s.moves.map((m) => m.servoId))).toEqual([[1, 2], [1]]);
	});
});

describe('recordingToSteps', () => {
	it('reports the initial pose, servo ids and duration', () => {
		const f = frames({ 1: [2000, 2000, 2000], 6: [900, 900, 900] });
		const r = recordingToSteps(f, { thresholdSteps: 5 });
		expect(r.servoIds).toEqual([1, 6]);
		expect(r.initial).toEqual({ 1: 2000, 6: 900 });
		expect(r.steps).toEqual([]);
		expect(r.frameCount).toBe(3);
		expect(r.durationS).toBeCloseTo(2 / HZ);
	});

	it('parses the live Pi format (header / frame / footer), using goal[] as servo ids 1..n', () => {
		const jsonl = [
			'{"event": "header", "version": "1", "rate_hz": 30, "joint_names": ["shoulder_pan", "gripper"]}',
			'{"event": "frame", "t": 0.0186, "leader": [1, 2], "follower": [3, 4], "goal": [2047, 2233]}',
			'{"event": "frame", "t": 0.0516, "leader": [1, 2], "follower": [3, 4], "goal": [2050, 2230]}',
			'{"event": "footer", "duration_s": 0.05, "frames": 2}'
		].join('\n');
		const { header, frames } = parseRecording(jsonl);
		expect(header).toEqual({ version: '1', rateHz: 30, jointNames: ['shoulder_pan', 'gripper'] });
		expect(frames).toEqual([
			{ t: 0.0186, positions: { '1': 2047, '2': 2233 } },
			{ t: 0.0516, positions: { '1': 2050, '2': 2230 } }
		]);
	});

	it('still parses the older {t, positions} format', () => {
		const jsonl = '{"t":0,"positions":{"1":2000}}\n{"t":0.033,"positions":{"1":2010}}\n';
		expect(parseRecording(jsonl)).toEqual({
			header: null,
			frames: [
				{ t: 0, positions: { '1': 2000 } },
				{ t: 0.033, positions: { '1': 2010 } }
			]
		});
		expect(() => parseRecording('{"nope":1}')).toThrow();
	});
});
