import { describe, expect, it } from 'vitest';
import { MOVE_GROUPS, groupKindQuery, groupOfKind, moveGroup } from './move-types';

describe('Movement Log type groups', () => {
	it('puts each kind in its group, by device', () => {
		expect(groupOfKind('arm', 'jog')?.id).toBe('arm:servo');
		expect(groupOfKind(undefined, 'hold')?.id).toBe('arm:whole');
		expect(groupOfKind('ot2', 'aspirate')?.id).toBe('ot2:liquid');
		expect(groupOfKind('ot2', 'moveToCoordinates')?.id).toBe('ot2:movement');
		expect(groupOfKind('ot2', 'dropTipInPlace')?.title).toBe('Tips');
	});
	it('sends an unnamed OT-2 kind to Other, and an unknown arm kind nowhere', () => {
		expect(groupOfKind('ot2', 'heaterShaker/setTargetTemperature')?.id).toBe('ot2:other');
		expect(groupOfKind('arm', 'mystery')).toBeNull();
	});
	it('queries a group by its kinds, and Other by every kind no group names', () => {
		expect(groupKindQuery(moveGroup('ot2:tips')!)).toEqual({ $in: ['pickUpTip', 'dropTip', 'dropTipInPlace'] });
		const other = groupKindQuery(moveGroup('ot2:other')!) as { $nin: string[] };
		expect(other.$nin).toContain('aspirate');
		expect(other.$nin).not.toContain('jog');
	});
	it('names no kind twice within a device', () => {
		for (const d of ['arm', 'ot2']) {
			const kinds = MOVE_GROUPS.filter((g) => g.device === d).flatMap((g) => g.kinds);
			expect(new Set(kinds).size).toBe(kinds.length);
		}
		expect(moveGroup('nope')).toBeNull();
	});
});
