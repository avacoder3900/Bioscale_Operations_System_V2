/**
 * Sacred middleware: a finalized document refuses updates and deletes; the
 * explicit `allowFinalized` option (annotations such as the Studio's resolve
 * stamps on well-tracker entries) lets one write through and is consumed so the
 * driver never sees it.
 */
import { describe, it, expect } from 'vitest';
import { applySacredMiddleware, ALLOW_FINALIZED_OPTION } from './sacred';

function hooksOf() {
	const hooks: Record<string, (this: any) => Promise<void> | void> = {};
	applySacredMiddleware({ pre: (op: string, fn: any) => (hooks[op] = fn) } as any);
	return hooks;
}
function query(finalized: boolean, options: Record<string, unknown> = {}) {
	return {
		options,
		getOptions() { return this.options; },
		getFilter: () => ({ _id: 'R1' }),
		model: { findOne: () => ({ select: () => ({ lean: async () => ({ _id: 'R1', finalizedAt: finalized ? new Date() : null }) }) }) }
	};
}

describe('sacred middleware', () => {
	it('blocks updateOne on a finalized document', async () => {
		await expect(hooksOf().updateOne.call(query(true))).rejects.toThrow(/finalized sacred document/);
	});
	it('allows updateOne on a document that is not finalized', async () => {
		await expect(hooksOf().updateOne.call(query(false))).resolves.toBeUndefined();
	});
	it('allowFinalized: true lets the write through and is removed from the options', async () => {
		const q = query(true, { [ALLOW_FINALIZED_OPTION]: true, arrayFilters: [{ 'w._id': 'x' }] });
		await expect(hooksOf().updateOne.call(q)).resolves.toBeUndefined();
		expect(q.options).toEqual({ arrayFilters: [{ 'w._id': 'x' }] });
	});
	it('a non-true value does not count as opt-in', async () => {
		await expect(hooksOf().updateOne.call(query(true, { [ALLOW_FINALIZED_OPTION]: 'yes' }))).rejects.toThrow();
	});
	it('deletes are always blocked', () => {
		expect(() => hooksOf().deleteOne.call(query(false))).toThrow(/cannot be deleted/);
	});
});
