import { describe, expect, it } from 'vitest';
import { isArmKey } from './change-labels';
import {
	ARM_TESTS,
	REQUIRED_PI_ROUTES,
	armTest,
	awayFromLimit,
	judgeDepth,
	judgeDrift,
	judgeGains,
	judgePresetReadback,
	judgeRoutes,
	judgeServoCount,
	judgeSpread,
	judgeThermals,
	judgeVoltage,
	maxDelta,
	spreadPerJoint
} from './arm-tests';

describe('catalog', () => {
	it('every test has a unique test.* key, a title and a one-line expectation', () => {
		expect(new Set(ARM_TESTS.map((t) => t.key)).size).toBe(ARM_TESTS.length);
		for (const t of ARM_TESTS) {
			expect(t.key.startsWith('test.')).toBe(true);
			expect(isArmKey(t.key), t.key).toBe(true);
			expect(t.title.length).toBeGreaterThan(0);
			expect(t.expected.length).toBeGreaterThan(0);
		}
	});
	it('finds a test by key and nothing for an unknown one', () => {
		expect(armTest('test.bus_echo')?.title).toBe('Bus Echo');
		expect(armTest('test.nope')).toBeNull();
	});
	it('only the replay needs a move set', () => {
		expect(ARM_TESTS.filter((t) => t.needsMoveSet).map((t) => t.key)).toEqual(['test.replay']);
	});
});

describe('maxDelta / awayFromLimit', () => {
	it('largest absolute difference over the shorter list', () => {
		expect(maxDelta([1, 2, 3], [1, 5, 3, 99])).toBe(3);
		expect(maxDelta([], [1])).toBe(0);
	});
	it('moves away from the encoder end', () => {
		expect(awayFromLimit(4080, 50)).toBe(-50);
		expect(awayFromLimit(10, 50)).toBe(50);
		expect(awayFromLimit(3000, 50)).toBe(-50);
		expect(awayFromLimit(1000, 50)).toBe(50);
	});
});

describe('judgeServoCount', () => {
	it('passes with 1..6 in any order and names the missing ones', () => {
		expect(judgeServoCount([6, 5, 4, 3, 2, 1]).pass).toBe(true);
		expect(judgeServoCount([1, 2, 4, 6])).toEqual({ pass: false, message: 'Missing Servo 3, 5' });
	});
});

describe('judgeDrift / judgeSpread', () => {
	it('drift at the limit passes, one over fails', () => {
		expect(judgeDrift([100, 200], [102, 200], 2).pass).toBe(true);
		expect(judgeDrift([100, 200], [103, 200], 2)).toEqual({ pass: false, message: 'Drift 3 Steps (Limit 2)' });
	});
	it('spread is max - min per joint over the samples', () => {
		expect(spreadPerJoint([[10, 20], [12, 20], [9, 25]])).toEqual([3, 5]);
		expect(spreadPerJoint([])).toEqual([]);
		const v = judgeSpread([[10, 20], [12, 20], [9, 45]], 20);
		expect(v.pass).toBe(false);
		expect(v.spread).toEqual([3, 25]);
	});
});

describe('judgeVoltage', () => {
	it('every servo inside the band passes', () => {
		expect(judgeVoltage([{ id: 1, voltage: 12.1 }, { id: 2, voltage: 11.5 }, { id: 3, voltage: 13.0 }]).pass).toBe(true);
	});
	it('a low, high or missing reading names the servo', () => {
		const v = judgeVoltage([{ id: 1, voltage: 11.4 }, { id: 2, voltage: 12 }, { id: 3, voltage: null }]);
		expect(v.pass).toBe(false);
		expect(v.message).toMatch(/^Servo 1, 3 Out Of 11.5-13 V/);
	});
});

describe('judgeThermals', () => {
	const cool = [{ id: 1, temperature: 40 }, { id: 2, temperature: 47 }];
	it('passes under the Pi hot line with no throttle flags and cool servos', () => {
		expect(judgeThermals({ temp_c: 50, hot_c: 55, now: [] }, cool).pass).toBe(true);
	});
	it('fails on the hot line, a flag, a warm servo, or no Pi reading', () => {
		expect(judgeThermals({ temp_c: 55, hot_c: 55, now: [] }, cool).message).toContain('Pi 55 C');
		expect(judgeThermals({ temp_c: 40, hot_c: 55, now: ['throttled'] }, cool).message).toContain('Throttle throttled');
		expect(judgeThermals({ temp_c: 40, hot_c: 55, now: [] }, [{ id: 3, temperature: 48 }]).message).toContain('Servo 3 48 C');
		expect(judgeThermals(null, cool).pass).toBe(false);
	});
});

describe('judgeRoutes', () => {
	it('lists what the Pi lacks', () => {
		const present = REQUIRED_PI_ROUTES.filter((r) => r !== '/servos/gains');
		expect(judgeRoutes([...present])).toMatchObject({ pass: false, missing: ['/servos/gains'] });
		expect(judgeRoutes([...REQUIRED_PI_ROUTES, '/extra']).pass).toBe(true);
	});
});

describe('judgePresetReadback', () => {
	it('names each control that differs or is missing', () => {
		const controls = [{ id: 'gain', value: 0 }, { id: 'exposure_time_absolute', value: 333 }];
		expect(judgePresetReadback({ gain: 0, exposure_time_absolute: 333 }, controls).pass).toBe(true);
		const v = judgePresetReadback({ gain: 4, exposure_time_absolute: 333, brightness: 1 }, controls);
		expect(v.differs).toEqual(['gain 0 (Preset 4)', 'brightness ? (Preset 1)']);
	});
});

describe('judgeGains', () => {
	it('judges only the servos with a logged value', () => {
		expect(judgeGains({ 2: 16, 3: 16 }, { 1: 6, 2: 16, 3: 16 })).toMatchObject({ pass: true, judged: 2, message: 'P 6 / 16 / 16' });
		expect(judgeGains({ 2: 16 }, { 1: 6, 2: 6 }).message).toBe('Servo 2 P 6 (Logged 16)');
		expect(judgeGains({}, { 1: 6 })).toMatchObject({ pass: false, judged: 0 });
	});
});

describe('judgeDepth', () => {
	it('every fixed tag within the limit passes; a missing depth fails', () => {
		expect(judgeDepth([{ name: 'Left', calibrationMm: 500, nowMm: 510 }]).pass).toBe(true);
		expect(judgeDepth([{ name: 'Left', calibrationMm: 500, nowMm: 530 }]).message).toBe('Off Left 30 mm (Limit 20)');
		expect(judgeDepth([{ name: 'Left', calibrationMm: 500, nowMm: null }]).pass).toBe(false);
		expect(judgeDepth([]).pass).toBe(false);
	});
});
