import { describe, expect, it } from 'vitest';
import { arrivalLine, arrivalReport, poseSaveLine, poseSaveReport, registerNote, servoRegisterStates, statusErrors, AT_POSE_STEPS } from './arrival';
import type { ServoReading } from './move-log';

const reading = (positions: number[], loads: number[] = []): ServoReading[] =>
	positions.map((p, i) => ({ id: i + 1, position: p, speed: 0, load: loads[i] ?? 0, voltage: 12.4, temperature: 41, torque: true }));

// "r.r.2 hover Copy" on 2026-11-10 22:00:51 UTC: from r.r.2 hover, the shoulder stopped 26 short.
const COPY = [2040, 2220, 2370, 1290, 500, 2500];
const FROM_HOVER = [2039, 2258, 2457, 1238, 496, 2492];
const ARRIVED = reading([2038, 2246, 2381, 1291, 496, 2492], [30, -199, -93, 0, 30, 44]);

describe('arrivalReport', () => {
	it('names the shoulder as the miss, with its load and direction, on the real Copy numbers', () => {
		const r = arrivalReport(COPY, ARRIVED, FROM_HOVER);
		expect(r.reached).toBe(false);
		expect(r.missed).toEqual([2]);
		expect(r.worst).toEqual({ servo: 2, off: 26 });
		const s2 = r.servos.find((s) => s.servo === 2)!;
		expect(s2).toMatchObject({ target: 2220, position: 2246, off: 26, asked: -38, moved: -12, direction: 'decreasing', load: -199, reached: false });
		expect(r.servos.find((s) => s.servo === 3)!.reached).toBe(true);
	});

	it('calls a play Reached when every servo is within the editor tolerance', () => {
		const r = arrivalReport([2040, 2240, 2450, 1230, 500, 2500], reading([2040, 2243, 2462, 1231, 497, 2492]), null);
		expect(r.reached).toBe(true);
		expect(r.missed).toEqual([]);
		expect(r.worst).toEqual({ servo: 3, off: 12 });
		expect(r.toleranceSteps).toBe(AT_POSE_STEPS);
	});

	it('is Not Read (reached null) without readings, and skips servos with no target', () => {
		const r = arrivalReport([2040, null, 2370], null, null);
		expect(r.reached).toBeNull();
		expect(r.servos.map((s) => s.servo)).toEqual([1, 3]);
	});

	it('treats a servo missing from the reading as not reached overall', () => {
		const r = arrivalReport([2040, 2220], [reading([2040])[0]], null);
		expect(r.reached).toBe(false);
		expect(r.missed).toEqual([]);
	});
});

describe('arrivalLine', () => {
	it('spells out each missed servo', () => {
		const line = arrivalLine('r.r.2 hover Copy', arrivalReport(COPY, ARRIVED, FROM_HOVER), { settledMs: 600 });
		expect(line).toBe('Arrival  r.r.2 hover Copy  Missed  Servo 2  Goal 2220  At 2246  Off +26  Load -199  Decreasing  Moved -12 Of -38  Settled 0.6 s');
	});

	it('gives the worst servo when reached, and Not Read without readings', () => {
		expect(arrivalLine('r.r.2 hover', arrivalReport([2040, 2240], reading([2040, 2243]), null))).toBe('Arrival  r.r.2 hover  Reached  Worst Servo 2 Off +3');
		expect(arrivalLine('x', arrivalReport([1], null, null), { note: 'Bus Busy' })).toBe('Arrival  x  Not Read  Bus Busy');
	});
});

describe('poseSaveReport / poseSaveLine', () => {
	it('flags a save whose numbers the arm is not at (slider 2220, arm 2244, 21:59 UTC)', () => {
		const r = poseSaveReport('edit', [2040, 2250, 2340, 1290, 500, 2500], COPY, reading([2038, 2244, 2375, 1292, 496, 2494], [0, -185]));
		expect(r.changed).toEqual([
			{ servo: 2, before: 2250, after: 2220 },
			{ servo: 3, before: 2340, after: 2370 }
		]);
		expect(poseSaveLine('r.r.2 hover Copy', r)).toBe(
			'Pose Edited  r.r.2 hover Copy  2: 2250 -> 2220  3: 2340 -> 2370  ⚠ Arm Not At Saved Numbers  Servo 2  Saved 2220  Arm 2244  Off +24  Load -185'
		);
	});

	it('says the arm is elsewhere when the save was made away from it, and Not Read without a reading', () => {
		const far = poseSaveReport('duplicate', null, COPY, reading([2040, 880, 3000, 894, 500, 2150]));
		expect(poseSaveLine('r.r.2 hover Copy 2', far, { from: 'r.r.2 hover Copy' })).toBe('Pose Duplicated  r.r.2 hover Copy 2  From r.r.2 hover Copy  Arm Elsewhere  Worst Servo 2 Off -1340');
		expect(poseSaveLine('p', poseSaveReport('save', null, COPY, null))).toBe('Pose Saved  p  Arm Not Read');
		expect(poseSaveLine('p', poseSaveReport('save', null, [2040], reading([2041])))).toBe('Pose Saved  p  Arm At Saved Numbers');
	});
});

describe('servo registers', () => {
	it('reads the Pi answer and decodes the status bits', () => {
		const s = servoRegisterStates({ servos: [{ id: 2, goal_position: 2220, position: 2246, load: -199, current: 40, status: 0b100000, moving: false, p_coefficient: 32, i_coefficient: 0 }] })!;
		expect(s[0]).toMatchObject({ id: 2, goalPosition: 2220, currentMa: 260, errors: ['Overload'], p: 32, i: 0, moving: false });
		expect(statusErrors(0b1001)).toEqual(['Voltage', 'Current']);
		expect(servoRegisterStates(null)).toBeNull();
		expect(servoRegisterStates({ detail: 'Not Found' })).toBeNull();
	});

	it('notes a goal register that is not the goal sent, and servo errors', () => {
		const s = servoRegisterStates([
			{ id: 1, goal_position: 2040, status: 0 },
			{ id: 2, goal_position: 2250, status: 32 }
		]);
		expect(registerNote(s, [2040, 2220])).toBe('Servo Goal Register Differs: 2: 2250 (Sent 2220)  ⚠ Servo Errors: 2: Overload');
		expect(registerNote(servoRegisterStates([{ id: 1, goal_position: 2040, status: 0 }]), [2040])).toBeNull();
	});
});
