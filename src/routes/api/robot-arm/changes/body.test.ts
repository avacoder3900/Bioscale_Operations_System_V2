import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, parseChangeRow, parseChangesBody } from './body';

const NOW = Date.parse('2026-11-06T12:00:00Z');

describe('parseChangeRow', () => {
	it('accepts a gain row from the Pi and defaults page / source to pi', () => {
		const p = parseChangeRow({ hardware: 'servo', key: 'servo.p_coefficient', target: 'servo:2', oldValue: 6, newValue: 16, note: 'Saved to EEPROM', at: '2026-11-06T11:59:00Z' }, NOW);
		expect(p.reason).toBeUndefined();
		expect(p.change).toMatchObject({ page: 'pi', source: 'pi', hardware: 'servo', key: 'servo.p_coefficient', target: 'servo:2', oldValue: 6, newValue: 16, note: 'Saved to EEPROM' });
		expect(p.change?.at?.toISOString()).toBe('2026-11-06T11:59:00.000Z');
	});
	it('rejects an unknown hardware or a bad key, naming the reason', () => {
		expect(parseChangeRow({ hardware: 'motor', key: 'servo.p_coefficient' }, NOW).reason).toBe('unknown hardware "motor"');
		expect(parseChangeRow({ hardware: 'servo', key: 'Servo Gain' }, NOW).reason).toBe('bad key "Servo Gain"');
		expect(parseChangeRow('nope', NOW).reason).toBe('not an object');
	});
	it('keeps hand and code sources, but never ui or test', () => {
		expect(parseChangeRow({ hardware: 'camera', key: 'hardware.cable', source: 'hand', page: 'hand' }, NOW).change).toMatchObject({ source: 'hand', page: 'hand' });
		expect(parseChangeRow({ hardware: 'servo', key: 'servo.torque', source: 'ui' }, NOW).change?.source).toBe('pi');
		expect(parseChangeRow({ hardware: 'servo', key: 'test.bus_echo', source: 'test' }, NOW).change?.source).toBe('pi');
		expect(parseChangeRow({ hardware: 'servo', key: 'servo.torque', page: 'teach' }, NOW).change?.page).toBe('teach');
		expect(parseChangeRow({ hardware: 'servo', key: 'servo.torque', page: 'nowhere' }, NOW).change?.page).toBe('pi');
	});
	it('clamps a date in the future or older than the window to now, and drops object values', () => {
		expect(parseChangeRow({ hardware: 'pi', key: 'pi.service.start', at: '2026-11-07T00:00:00Z' }, NOW).change?.at?.getTime()).toBe(NOW);
		expect(parseChangeRow({ hardware: 'pi', key: 'pi.service.start', at: new Date(NOW - MAX_AGE_MS - 1).toISOString() }, NOW).change?.at?.getTime()).toBe(NOW);
		expect(parseChangeRow({ hardware: 'pi', key: 'pi.service.start', at: new Date(NOW - 1000).toISOString() }, NOW).change?.at?.getTime()).toBe(NOW - 1000);
		expect(parseChangeRow({ hardware: 'pi', key: 'pi.app_py', newValue: { a: 1 } }, NOW).change?.newValue).toBeNull();
	});
});

describe('parseChangesBody', () => {
	it('splits good rows from rejected ones by index and keeps the host', () => {
		const out = parseChangesBody({ host: 'arm-pi', changes: [{ hardware: 'pi', key: 'pi.router.thermal', newValue: 'Installed' }, { hardware: 'x', key: 'pi.router.thermal' }] }, NOW);
		expect(out.host).toBe('arm-pi');
		expect(out.changes.map((c) => c.index)).toEqual([0]);
		expect(out.rejected).toEqual([{ index: 1, reason: 'unknown hardware "x"' }]);
	});
	it('refuses a body with no changes array, an empty one, or too many', () => {
		expect(() => parseChangesBody(null, NOW)).toThrow();
		expect(() => parseChangesBody({ changes: 'x' }, NOW)).toThrow();
		expect(() => parseChangesBody({ changes: [] }, NOW)).toThrow();
		expect(() => parseChangesBody({ changes: new Array(51).fill({ hardware: 'pi', key: 'pi.a' }) }, NOW)).toThrow();
	});
});
