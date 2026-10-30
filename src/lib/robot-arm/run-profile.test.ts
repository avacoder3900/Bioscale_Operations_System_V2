import { describe, expect, it } from 'vitest';
import { classifyPoint, profileRun, type Ot2CommandSummary, type ProfileLandmarks } from './run-profile';

const T0 = Date.parse('2026-10-30T15:00:00.000Z');
const LM: ProfileLandmarks = { cart: { x: 200, y: 100 }, scan: { x: 260, y: 150 }, calibrator: { x: 125, y: 173 } };

/** A command log laid end to end: each entry runs `s` seconds, optionally after a `gap`. */
function log(entries: { type: string; s: number; gap?: number; params?: Record<string, unknown> }[]): Ot2CommandSummary[] {
	let t = T0;
	return entries.map((e, i) => {
		t += (e.gap ?? 0) * 1000;
		const startedAt = new Date(t).toISOString();
		t += e.s * 1000;
		const completedAt = new Date(t).toISOString();
		return { id: `c${i}`, commandType: e.type, status: 'succeeded', startedAt, completedAt, params: e.params ?? {} };
	});
}

const lift = (s = 2) => ({ type: 'home', s, params: { axes: ['rightZ'] } });
const tube = (s = 3) => ({ type: 'moveToWell', s, params: { labwareId: 'tuberack', wellName: 'A3' } });
const at = (p: { x: number; y: number }, s = 3) => ({ type: 'moveToCoordinates', s, params: { coordinates: { ...p, z: 50 } } });
const pause = (message: string, s: number) => ({ type: 'waitForResume', s, params: { message } });
const say = (message: string) => ({ type: 'comment', s: 0, params: { message } });

const ONE_CART = log([
	{ type: 'home', s: 20, params: {} },
	{ type: 'pickUpTip', s: 5, params: { labwareId: 'tiprack', wellName: 'A1' } },
	at(LM.calibrator!, 4),
	say('ARM CALIBRATED'),
	lift(),
	tube(),
	{ type: 'aspirate', s: 2.4, params: { labwareId: 'tuberack', wellName: 'A3', volume: 17.9 } },
	{ type: 'waitForDuration', s: 2, params: { seconds: 2 } },
	pause('ARM PARKED 1', 50),
	// cart 1
	lift(),
	at(LM.scan!, 4),
	pause('ARM AT_SCAN 1', 10),
	lift(),
	at(LM.cart!, 3),
	{ type: 'waitForDuration', s: 0.3, params: { seconds: 0.3 } },
	{ type: 'dispenseInPlace', s: 0.65, params: { volume: 1.6 } },
	{ type: 'moveToCoordinates', s: 0.5, gap: 0.5, params: { coordinates: { x: 194, y: 100, z: 50 } } },
	{ type: 'dispenseInPlace', s: 0.65, params: { volume: 1.6 } },
	say('ARM CART 1 FILLED f4bb'),
	lift(),
	tube(),
	say('ARM CLEAR 1'),
	{ type: 'aspirate', s: 2.4, params: { labwareId: 'tuberack', wellName: 'A3', volume: 17.9 } },
	pause('ARM PARKED 2', 40),
	// wind-down
	lift(),
	tube(2),
	{ type: 'blowOut', s: 0.5, params: { labwareId: 'tuberack', wellName: 'A3' } },
	{ type: 'dropTip', s: 3, params: { labwareId: 'fixedTrash', wellName: 'A1' } },
	{ type: 'home', s: 15, params: {} },
	say('ARM LOOP END')
]);

describe('run-profile', () => {
	it('classifies bare-point moves by the nearest taught point, stage when nothing is near', () => {
		expect(classifyPoint({ x: 201, y: 99 }, LM)).toBe('stage');
		expect(classifyPoint({ x: 262, y: 148 }, LM)).toBe('scan');
		expect(classifyPoint({ x: 126, y: 170 }, LM)).toBe('calibrator');
		expect(classifyPoint({ x: 10, y: 10 }, LM)).toBe('stage');
		expect(classifyPoint({ x: 262, y: 148 }, undefined)).toBe('stage');
	});

	it('cuts the run into start-up, one phase per cart, and the wind-down at the PARKED pauses', () => {
		const p = profileRun('run-1', ONE_CART, { status: 'succeeded', startedAt: ONE_CART[0].startedAt, completedAt: ONE_CART[ONE_CART.length - 1].completedAt, landmarks: LM });
		expect(p.phases.map((x) => x.label)).toEqual(['Start-up', 'Cart 1', 'Wind-down']);
		expect(p.phases.map((x) => x.cart)).toEqual([null, 1, 2]);
		expect(p.phases[1].outcome).toBe('filled');
		expect(p.commandCount).toBe(ONE_CART.length);
		expect(p.notes).toEqual([]);
	});

	it('buckets the seconds per station and counts lifts, trips and holes', () => {
		const p = profileRun('run-1', ONE_CART, { status: 'succeeded', landmarks: LM });
		const [startup, cart, wind] = p.phases;
		expect(startup.buckets.home).toBe(20);
		expect(startup.buckets.tiprack).toBe(5);
		expect(startup.buckets.calibrator).toBe(4);
		expect(startup.buckets.lift).toBe(2);
		expect(startup.buckets.tube).toBeCloseTo(5.4, 2); // move 3 + aspirate 2.4
		expect(startup.buckets.delay).toBe(2);
		expect(startup.buckets.parked).toBe(50);
		expect(startup.counts.aspirates).toBe(1);
		expect(startup.totalS).toBeCloseTo(20 + 5 + 4 + 2 + 3 + 2.4 + 2 + 50, 1);

		expect(cart.buckets.lift).toBe(6);
		expect(cart.buckets.scan).toBe(4);
		expect(cart.buckets.atScan).toBe(10);
		expect(cart.buckets.stage).toBeCloseTo(3 + 0.65 + 0.5 + 0.65, 2);
		expect(cart.buckets.delay).toBeCloseTo(0.3, 2);
		expect(cart.buckets.gap).toBeCloseTo(0.5, 2);
		expect(cart.buckets.tube).toBeCloseTo(3 + 2.4, 2);
		expect(cart.buckets.parked).toBe(40);
		expect(cart.counts).toMatchObject({ lifts: 3, aspirates: 1, holes: 2 });

		expect(wind.buckets.trash).toBe(3);
		expect(wind.buckets.home).toBe(15);
		expect(wind.buckets.tube).toBeCloseTo(2.5, 2);
		expect(wind.counts.lifts).toBe(1);
	});

	it('explains a run that never parked, and counts a NO_INSTRUCTION re-pause with the pause it followed', () => {
		const early = log([{ type: 'home', s: 20, params: {} }, { type: 'pickUpTip', s: 5, params: { labwareId: 't', wellName: 'A1' } }]);
		const p = profileRun('run-2', early, { status: 'failed' });
		expect(p.phases).toHaveLength(1);
		expect(p.notes.some((n) => n.includes('never reached ARM PARKED 1'))).toBe(true);
		expect(p.notes.some((n) => n.includes('No taught points'))).toBe(true);

		const resumed = log([pause('ARM PARKED 1', 10), lift(), at(LM.scan!, 4), pause('ARM AT_SCAN 1', 5), pause('ARM NO_INSTRUCTION 1', 7), pause('ARM PARKED 2', 1)]);
		const q = profileRun('run-3', resumed, { landmarks: LM });
		expect(q.phases[1].buckets.atScan).toBe(12);
		expect(q.notes.some((n) => n.startsWith('ARM NO_INSTRUCTION 1'))).toBe(true);
	});

	it('ignores commands that never ran and reports the run total from the run itself', () => {
		const cmds = [...ONE_CART, { commandType: 'home', status: 'queued', params: {} } as Ot2CommandSummary];
		const p = profileRun('run-4', cmds, { startedAt: ONE_CART[0].startedAt, completedAt: new Date(T0 + 600_000).toISOString(), landmarks: LM });
		expect(p.totalS).toBe(600);
		expect(p.phases[2].counts.commands).toBe(6);
	});
});
