/**
 * CALIB-5 rack offsets: the numbers that reach a pick-up.
 *
 * Why these exist: on 2026-10-26 one shared tip-rack definition carried R04's
 * +2/+5 to B07 and broke B07's pick-ups. The per-robot vector must (a) only
 * ever reach the robot it was taught on, (b) refuse anything that is not a
 * "slightly differently seated rack", and (c) always be explicit in the RTPs a
 * run is created with, so the run record says what was applied.
 *
 * The Mongo model and the definition resolver are faked in memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type Doc = Record<string, any>;
const store = vi.hoisted(() => ({ rows: new Map<string, Doc>(), audits: [] as Doc[] }));
const keyOf = (q: Doc) => `${q.robotId}|${q.definitionUri}|${q.slotName}`;

vi.mock('$lib/server/db', () => ({
	connectDB: async () => {},
	generateId: () => 'gen',
	AuditLog: { create: async (d: Doc) => store.audits.push(d) },
	RobotLabwareOffset: {
		findOne: (q: Doc) => ({ lean: async () => store.rows.get(keyOf(q)) ?? null }),
		find: (q: Doc) => ({ sort: () => ({ lean: async () => [...store.rows.values()].filter((r) => r.robotId === q.robotId) }) }),
		updateOne: async (q: Doc, update: Doc) => {
			const k = keyOf(q);
			const cur = store.rows.get(k) ?? { ...q, _id: update.$setOnInsert?._id, history: [] };
			Object.assign(cur, update.$set ?? {});
			if (update.$push?.history) {
				const { $each, $slice } = update.$push.history;
				cur.history = [...$each, ...(cur.history ?? [])].slice(0, $slice);
			}
			if (update.$pop?.history === -1) cur.history = (cur.history ?? []).slice(1);
			store.rows.set(k, cur);
		}
	}
}));
vi.mock('./resolve', () => ({
	resolveLabwareDefinition: async (loadName: string) => {
		if (loadName === 'missing_rack') throw new Error(`Labware definition "${loadName}" not found`);
		const ns = loadName === 'cosmasanddamian_96_tiprack_20ul' ? 'custom_beta' : 'cosmas_damian';
		return { doc: {}, matchCount: 1, uri: `${ns}/${loadName}/1` };
	}
}));

import {
	RACK_OFFSET_LIMIT_MM,
	checkRackOffset,
	rackSlotFor,
	rackOffsetRtpValues,
	saveRackOffset,
	revertRackOffset,
	getRackOffset
} from './rack-offsets';

const R04 = 'CCyX8FjTRGvYOd9vISGvi';
const B07 = '2vIu0fzsbqzkZ7_Zjj3h2';
const TIP20 = 'cosmasanddamian_96_tiprack_20ul';
const TIP20_URI = `custom_beta/${TIP20}/1`;
const user = { _id: 'u1', username: 'tester' };
const tipSchema = ['tiprack_offset_x', 'tiprack_offset_y', 'tiprack_offset_z'].map((variableName) => ({ variableName, min: -10, max: 10 }));
const bothSchema = [...tipSchema, ...['tuberack_offset_x', 'tuberack_offset_y', 'tuberack_offset_z'].map((variableName) => ({ variableName, min: -10, max: 10 }))];

beforeEach(() => {
	store.rows.clear();
	store.audits.length = 0;
});

describe('guards', () => {
	it('rackSlotFor knows the four racks and nothing else', () => {
		expect(rackSlotFor(TIP20)).toBe('11');
		expect(rackSlotFor('cosmas_and_damian_biotix_96_200ul_tiprack')).toBe('11');
		expect(rackSlotFor('cosmas_and_damian_drybath_tuberack')).toBe('10');
		expect(rackSlotFor('custom_2ml_24_tube_rack')).toBe('10');
		expect(rackSlotFor('gen4deck_gen7cartridge_004')).toBeNull();
	});
	it('checkRackOffset refuses (never clamps) anything beyond the limit or not a number', () => {
		expect(checkRackOffset({ x: 2, y: -4, z: 0 })).toBeNull();
		expect(checkRackOffset({ x: RACK_OFFSET_LIMIT_MM, y: 0, z: 0 })).toBeNull();
		expect(checkRackOffset({ x: RACK_OFFSET_LIMIT_MM + 0.5, y: 0, z: 0 })).toMatch(/re-seat/);
		expect(checkRackOffset({ x: 0, y: NaN, z: 0 })).toMatch(/not a number/);
	});
});

describe('saveRackOffset / revertRackOffset', () => {
	it('a captured delta adds to the stored vector, keeps history, writes one audit row — for that robot only', async () => {
		const first = await saveRackOffset({ robotId: R04, loadName: TIP20, vector: { x: 2, y: 5, z: 0 }, user, source: 'migration', note: 'R04 working state' });
		expect(first).toMatchObject({ definitionUri: TIP20_URI, slotName: '11', before: { x: 0, y: 0, z: 0 }, after: { x: 2, y: 5, z: 0 } });
		const second = await saveRackOffset({ robotId: R04, loadName: TIP20, delta: { x: 0, y: -1, z: 0 }, user });
		expect(second.after).toEqual({ x: 2, y: 4, z: 0 });
		expect((await getRackOffset(R04, TIP20_URI, '11'))?.vector).toEqual({ x: 2, y: 4, z: 0 });
		expect(await getRackOffset(B07, TIP20_URI, '11')).toBeNull();
		expect(store.audits.map((a) => a.action)).toEqual(['save_rack_offset', 'save_rack_offset']);
		expect(store.audits[1].newData).toMatchObject({ robotId: R04, before: { x: 2, y: 5, z: 0 }, after: { x: 2, y: 4, z: 0 } });

		const reverted = await revertRackOffset({ robotId: R04, loadName: TIP20, user });
		expect(reverted.after).toEqual({ x: 2, y: 5, z: 0 });
		expect(store.audits.at(-1)?.action).toBe('revert_rack_offset');
	});
	it('refuses a vector past the limit and a non-rack load name', async () => {
		await expect(saveRackOffset({ robotId: B07, loadName: TIP20, delta: { x: 11, y: 0, z: 0 }, user })).rejects.toThrow(/re-seat/);
		await expect(saveRackOffset({ robotId: B07, loadName: 'gen4deck_gen7cartridge_004', delta: { x: 1, y: 0, z: 0 }, user })).rejects.toThrow(/slot 10\/11/);
		expect(store.rows.size).toBe(0);
	});
});

describe('rackOffsetRtpValues — what a fill start injects', () => {
	it('nothing for a protocol that does not declare the RTPs', async () => {
		await saveRackOffset({ robotId: R04, loadName: TIP20, vector: { x: 2, y: 4, z: 0 }, user });
		const r = await rackOffsetRtpValues(R04, [{ variableName: 'cartridges' }], { '10': 'cosmas_and_damian_drybath_tuberack', '11': TIP20 });
		expect(r).toEqual({ rtp: {}, applied: [] });
	});
	it("this robot's vector for declared racks; an untaught rack is an explicit 0; other robots never see it", async () => {
		await saveRackOffset({ robotId: R04, loadName: TIP20, vector: { x: 2, y: 4, z: 0 }, user });
		const r04 = await rackOffsetRtpValues(R04, bothSchema, { '10': 'cosmas_and_damian_drybath_tuberack', '11': TIP20 });
		expect(r04.rtp).toEqual({ tiprack_offset_x: 2, tiprack_offset_y: 4, tiprack_offset_z: 0, tuberack_offset_x: 0, tuberack_offset_y: 0, tuberack_offset_z: 0 });
		expect(r04.applied.map((a) => [a.slotName, a.definitionUri, a.vector])).toEqual([
			['10', 'cosmas_damian/cosmas_and_damian_drybath_tuberack/1', { x: 0, y: 0, z: 0 }],
			['11', TIP20_URI, { x: 2, y: 4, z: 0 }]
		]);
		const b07 = await rackOffsetRtpValues(B07, bothSchema, { '10': 'cosmas_and_damian_drybath_tuberack', '11': TIP20 });
		expect(b07.rtp).toEqual({ tiprack_offset_x: 0, tiprack_offset_y: 0, tiprack_offset_z: 0, tuberack_offset_x: 0, tuberack_offset_y: 0, tuberack_offset_z: 0 });
	});
	it('only the slots whose rack is named and whose three RTPs are all declared', async () => {
		await saveRackOffset({ robotId: R04, loadName: TIP20, vector: { x: 2, y: 4, z: 0 }, user });
		const r = await rackOffsetRtpValues(R04, tipSchema, { '11': TIP20 });
		expect(Object.keys(r.rtp).sort()).toEqual(['tiprack_offset_x', 'tiprack_offset_y', 'tiprack_offset_z']);
		const partial = await rackOffsetRtpValues(R04, tipSchema.slice(0, 2), { '11': TIP20 });
		expect(partial).toEqual({ rtp: {}, applied: [] });
	});
	it('clamps to the declared range and survives an unresolvable rack with a zero offset', async () => {
		await saveRackOffset({ robotId: R04, loadName: TIP20, vector: { x: 9, y: 0, z: 0 }, user });
		const tight = tipSchema.map((p) => ({ ...p, max: 5, min: -5 }));
		const r = await rackOffsetRtpValues(R04, tight, { '11': TIP20 });
		expect(r.rtp.tiprack_offset_x).toBe(5);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		try {
			const m = await rackOffsetRtpValues(R04, bothSchema, { '10': 'missing_rack', '11': TIP20 });
			expect(m.rtp.tuberack_offset_x).toBe(0);
			expect(m.applied.find((a) => a.slotName === '10')?.definitionUri).toBe('missing_rack');
		} finally {
			warn.mockRestore();
		}
	});
});
