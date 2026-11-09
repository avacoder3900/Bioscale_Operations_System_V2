import { describe, it, expect } from 'vitest';
import { parseCartIdList, planWaxFilledScrap } from './wax-filled-scrap';

describe('parseCartIdList', () => {
	it('splits a pasted list on new lines, spaces, commas and semicolons', () => {
		expect(parseCartIdList('a\r\nb, c;d  e\n')).toEqual(['a', 'b', 'c', 'd', 'e']);
	});

	it('drops repeats and keeps the first order', () => {
		expect(parseCartIdList('b a b a')).toEqual(['b', 'a']);
	});

	it('copes with nothing', () => {
		expect(parseCartIdList(null)).toEqual([]);
		expect(parseCartIdList('  \n ')).toEqual([]);
	});
});

describe('planWaxFilledScrap', () => {
	it('keeps the named carts and scraps every other wax-filled cart', () => {
		const plan = planWaxFilledScrap(['a', 'b', 'c', 'd'], ['b', 'd'], []);
		expect(plan).toEqual({ keep: ['b', 'd'], scrap: ['a', 'c'], notWaxFilled: [], checkedOut: 0 });
	});

	it('leaves checked-out carts alone and counts them', () => {
		const plan = planWaxFilledScrap(['a', 'b', 'c'], ['a'], ['c', 'z']);
		expect(plan.scrap).toEqual(['b']);
		expect(plan.checkedOut).toBe(1);
	});

	it('reports named carts that are not in the wax-filled count', () => {
		const plan = planWaxFilledScrap(['a', 'b'], ['a', 'x', 'b'], ['b']);
		expect(plan.keep).toEqual(['a']);
		expect(plan.notWaxFilled).toEqual(['x', 'b']);
		expect(plan.scrap).toEqual([]);
	});

	it('never scraps a named cart', () => {
		const plan = planWaxFilledScrap(['a', 'b', 'c'], ['a', 'b', 'c'], []);
		expect(plan.scrap).toEqual([]);
	});
});
