import { describe, it, expect } from 'vitest';
import { partitionMissingActions, parseLooseDecision, isMissingAction, LOOSE_STATUS } from './bucket-loose';

describe('partitionMissingActions', () => {
	const missing = ['A', 'B', 'C', 'D'];

	it('sorts each missing member into the group the operator chose', () => {
		const plan = partitionMissingActions(missing, [
			{ barcode: 'A', action: 'discard' },
			{ barcode: 'B', action: 'loose' },
			{ barcode: 'C', action: 'oven' },
			{ barcode: 'D', action: 'release' }
		]);
		expect(plan).toEqual({ discards: ['A'], loose: ['B'], oven: ['C'], releases: ['D'] });
	});

	it('ignores codes that are not missing members (a stale list from an older board)', () => {
		const plan = partitionMissingActions(missing, [{ barcode: 'Z', action: 'loose' }, { barcode: 'A', action: 'loose' }]);
		expect(plan.loose).toEqual(['A']);
	});

	it('takes the last choice for a code listed twice, and trims the code', () => {
		const plan = partitionMissingActions(missing, [{ barcode: 'A', action: 'discard' }, { barcode: ' A ', action: 'oven' }]);
		expect(plan.discards).toEqual([]);
		expect(plan.oven).toEqual(['A']);
	});

	it('leaves a cart on the pass when the action is not one the board knows (keep included)', () => {
		const plan = partitionMissingActions(missing, [{ barcode: 'A', action: 'keep' }, { barcode: 'B', action: 'oven' }, { barcode: 'B', action: 'keep' }]);
		expect(plan).toEqual({ discards: [], releases: [], loose: [], oven: [] });
	});

	it('copes with nothing chosen', () => {
		expect(partitionMissingActions(missing, undefined)).toEqual({ discards: [], releases: [], loose: [], oven: [] });
		expect(partitionMissingActions(missing, [])).toEqual({ discards: [], releases: [], loose: [], oven: [] });
	});
});

describe('loose decisions', () => {
	it('accepts only the three decisions the Loose pile offers', () => {
		expect(parseLooseDecision('bucket')).toBe('bucket');
		expect(parseLooseDecision('oven')).toBe('oven');
		expect(parseLooseDecision('trash')).toBe('trash');
		expect(parseLooseDecision('keep')).toBeNull();
		expect(parseLooseDecision(undefined)).toBeNull();
	});

	it('knows the audit actions, keep excluded', () => {
		expect(isMissingAction('loose')).toBe(true);
		expect(isMissingAction('oven')).toBe(true);
		expect(isMissingAction('keep')).toBe(false);
	});

	it('loose is its own status, not a bucket stage', () => {
		expect(LOOSE_STATUS).toBe('loose');
	});
});
