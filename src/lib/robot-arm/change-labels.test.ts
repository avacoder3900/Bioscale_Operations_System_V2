import { describe, expect, it } from 'vitest';
import { ARM_HARDWARE, ARM_PAGES, changeLine, formatValue, isArmKey, labelTitle } from './change-labels';

describe('isArmKey', () => {
	it('accepts dotted lower-case keys with at least two parts', () => {
		for (const k of ['servo.p_coefficient', 'conveyor.pulse_ms', 'test.bus_echo', 'pi.router.thermal', 'camera.exposure_time_absolute']) {
			expect(isArmKey(k), k).toBe(true);
		}
	});
	it('rejects one-part, capitalised, spaced or dashed keys', () => {
		for (const k of ['servo', 'Servo.gain', 'servo gain', 'servo-gain', '', null, 3, 'servo.', '.servo']) {
			expect(isArmKey(k), String(k)).toBe(false);
		}
	});
});

describe('formatValue', () => {
	it('prints booleans as On / Off and numbers plainly', () => {
		expect(formatValue(true)).toBe('On');
		expect(formatValue(false)).toBe('Off');
		expect(formatValue(16)).toBe('16');
		expect(formatValue(1.23456)).toBe('1.235');
		expect(formatValue(null)).toBe('');
		expect(formatValue([6, 16, 16])).toBe('6, 16, 16');
		expect(formatValue({ a: 1 })).toBe('{"a":1}');
	});
});

describe('changeLine', () => {
	const base = { page: 'teach', hardware: 'servo' } as const;
	it('old -> new with target and unit', () => {
		expect(changeLine({ ...base, key: 'servo.p_coefficient', target: 'servo:2', oldValue: 6, newValue: 16 })).toBe('servo.p_coefficient servo:2 6 -> 16');
		expect(changeLine({ ...base, key: 'conveyor.pulse_ms', oldValue: 1000, newValue: 600, unit: 'ms' })).toBe('conveyor.pulse_ms 1000 -> 600 ms');
	});
	it('a value alone when there was no old one', () => {
		expect(changeLine({ ...base, key: 'conveyor.pulse_ms', newValue: 600, unit: 'ms' })).toBe('conveyor.pulse_ms 600 ms');
		expect(changeLine({ ...base, key: 'test.bus_echo', newValue: 'Pass' })).toBe('test.bus_echo Pass');
	});
	it('a cleared value shows what it was', () => {
		expect(changeLine({ ...base, key: 'home.capture', oldValue: 'abc', newValue: null })).toBe('home.capture abc -> ');
	});
	it('the key alone when nothing else is known', () => {
		expect(changeLine({ ...base, key: 'pi.service.restart' })).toBe('pi.service.restart');
	});
});

describe('labelTitle', () => {
	it('Title Cases dotted and dashed labels', () => {
		expect(labelTitle('calibrate.arm')).toBe('Calibrate Arm');
		expect(labelTitle('leader-arm')).toBe('Leader Arm');
		expect(labelTitle('maintenance.sync-zero')).toBe('Maintenance Sync Zero');
		expect(labelTitle('pi')).toBe('Pi');
	});
});

describe('label lists', () => {
	it('hold no duplicates and only lower-case values', () => {
		for (const list of [ARM_PAGES, ARM_HARDWARE]) {
			expect(new Set(list).size).toBe(list.length);
			for (const v of list) expect(v).toBe(v.toLowerCase());
		}
	});
});
