import { describe, expect, it } from 'vitest';
import {
	allPartsScanned,
	bucketLabel,
	buildProgress,
	buildStatus,
	currentStep,
	deducts,
	partsLeft,
	partsProgress,
	sectionConfirmed,
	findStepForPart,
	firstOpenSection,
	liveScan,
	normalizeBucketCode,
	scanKey,
	scannedKeys,
	sectionsUsingPart,
	stepTitle,
	type WiLike
} from './progress';

const wi: WiLike = {
	sections: [
		{
			number: 0,
			type: 'setup',
			title: 'Cleaning and Setup',
			steps: [
				{ _id: 's0a', stepNumber: 1, title: 'Wipe the work surface.', materials: [{ _id: 't1', kind: 'supply', name: '70% Alcohol Wipes' }] },
				{ _id: 's0b', stepNumber: 2, title: 'Attach ESD wrist strap.', requiresEsd: true }
			]
		},
		{
			number: 1,
			type: 'subassembly',
			title: 'Mainboard',
			tabLabel: 'Electronics',
			steps: [
				{
					_id: 's1a',
					stepNumber: 1,
					title: 'Attach the Upper Magnet Bracket.',
					materials: [
						{ _id: 'm1', kind: 'part', partNumber: 'PT-SPU-012', partDefinitionId: 'pd12', name: 'Upper Magnet Bracket', quantity: 1 },
						{ _id: 'm2', kind: 'part', partNumber: 'PT-SPU-029', partDefinitionId: 'pd29', name: 'M3 x 10 mm SHCS', quantity: 2 },
						{ _id: 'm3', kind: 'tool', partNumber: 'TOOL-SPU-025', name: 'Hex 2.5 Screwdriver' }
					]
				},
				{
					_id: 's1b',
					stepNumber: 2,
					title: '',
					instructionsText: 'Attach Main Board Fuse to Main Board.\nPress firmly.',
					materials: [
						{ _id: 'm4', kind: 'part', partNumber: 'PT-SPU-029', partDefinitionId: 'pd29', name: 'M3 x 10 mm SHCS', quantity: 1 },
						{ _id: 'm5', kind: 'part', partNumber: 'PT-SPU-053', partDefinitionId: null, name: 'Main Board Fuse' }
					]
				}
			]
		}
	]
};

describe('normalizeBucketCode', () => {
	it('reduces a bucket QR code to its UUID in lower case, from a bare UUID or a link', () => {
		expect(normalizeBucketCode('Fbc6f691-28dd-4741-a778-db1835f55fca')).toBe('fbc6f691-28dd-4741-a778-db1835f55fca');
		expect(normalizeBucketCode(' 01883D73-E4DC-4530-B82A-54555D4C500F ')).toBe('01883d73-e4dc-4530-b82a-54555d4c500f');
		expect(normalizeBucketCode('https://example.test/b/01883d73-e4dc-4530-b82a-54555d4c500f?x=1')).toBe('01883d73-e4dc-4530-b82a-54555d4c500f');
	});

	it('upper-cases any other label and rejects things that cannot be labels', () => {
		expect(normalizeBucketCode(' bkt-000123 ')).toBe('BKT-000123');
		expect(normalizeBucketCode('')).toBeNull();
		expect(normalizeBucketCode('BKT 001')).toBeNull();
		expect(normalizeBucketCode('x'.repeat(65))).toBeNull();
	});

	it('names buckets by number, falling back to the code for older builds', () => {
		expect(bucketLabel({ bucketNumber: 2, bucketCode: 'fbc6f691-28dd-4741-a778-db1835f55fca' })).toBe('Bucket 2');
		expect(bucketLabel({ number: 3 })).toBe('Bucket 3');
		expect(bucketLabel({ bucketCode: 'BKT-001' })).toBe('Bucket BKT-001');
	});
});

describe('stepTitle', () => {
	it('falls back to the first line of the instructions, then to a placeholder', () => {
		expect(stepTitle(wi.sections[1].steps[1])).toBe('Attach Main Board Fuse to Main Board.');
		expect(stepTitle({ _id: 'x', stepNumber: 9 })).toBe('Untitled step');
	});
});

describe('deducts', () => {
	it('only deducts catalog-linked parts that are not opted out', () => {
		expect(deducts({ _id: 'a', kind: 'part', name: 'x', partDefinitionId: 'p' })).toBe(true);
		expect(deducts({ _id: 'a', kind: 'part', name: 'x', partDefinitionId: null })).toBe(false);
		expect(deducts({ _id: 'a', kind: 'part', name: 'x', partDefinitionId: 'p', deductFromInventory: false })).toBe(false);
	});
});

describe('findStepForPart', () => {
	const section = wi.sections[1];

	it('routes a part to the first step that still needs it', () => {
		const hit = findStepForPart(section, { scans: [] }, { partDefinitionId: 'pd29' });
		expect(hit.kind === 'found' && hit.step._id).toBe('s1a');
	});

	it('moves on to the next step only once every part of the current one is in, matching by part number too', () => {
		const partial = { scans: [{ stepId: 's1a', materialId: 'm2' }] };
		expect(currentStep(section, partial)?._id).toBe('s1a');
		expect(partsLeft(section.steps[0], partial).map((m) => m._id)).toEqual(['m1']);
		const out = findStepForPart(section, partial, { partNumber: 'pt-spu-029' });
		expect(out.kind === 'out-of-order' && [out.current._id, out.step._id]).toEqual(['s1a', 's1b']);

		const full = { scans: ['m1', 'm2'].map((materialId) => ({ stepId: 's1a', materialId })) };
		expect(currentStep(section, full)?._id).toBe('s1b');
		const hit = findStepForPart(section, full, { partNumber: 'pt-spu-029' });
		expect(hit.kind === 'found' && hit.material._id).toBe('m4');
	});

	it('refuses a later step’s part while the current step still needs parts', () => {
		const hit = findStepForPart(section, { scans: [] }, { partNumber: 'PT-SPU-053' });
		expect(hit.kind).toBe('out-of-order');
	});

	it('says when every part in the section is in, and confirms sections from completed steps', () => {
		const all = { scans: [['s1a', 'm1'], ['s1a', 'm2'], ['s1b', 'm4'], ['s1b', 'm5']].map(([stepId, materialId]) => ({ stepId, materialId })) };
		expect(currentStep(section, all)).toBeNull();
		expect(findStepForPart(section, all, { partDefinitionId: 'pd29' }).kind).toBe('section-scanned');
		expect(partsProgress(wi.sections, all)).toEqual({ scanned: 4, total: 4 });
		expect(sectionConfirmed(section, all)).toBe(false);
		expect(sectionConfirmed(section, { completedSteps: [{ stepId: 's1a' }, { stepId: 's1b' }] })).toBe(true);
		expect(currentStep(wi.sections[0], {})).toBeNull(); // Setup: no parts to scan
	});

	it('counts a scan still in flight as taken, so a double-fired scanner cannot claim twice', () => {
		const build = { scans: [{ stepId: 's1a', materialId: 'm1', status: 'pending' }] };
		expect(findStepForPart(section, build, { partDefinitionId: 'pd12' }).kind).toBe('already-scanned');
	});

	it('says when the part is not used in this section', () => {
		expect(findStepForPart(wi.sections[0], { scans: [] }, { partDefinitionId: 'pd12' }).kind).toBe('not-in-section');
		expect(sectionsUsingPart(wi, { partDefinitionId: 'pd12' }).map((s) => s.number)).toEqual([1]);
	});
});

describe('completion', () => {
	it('needs every part on the step scanned, and ignores scans still in flight', () => {
		const step = wi.sections[1].steps[0];
		const half = { scans: [{ stepId: 's1a', materialId: 'm1', status: 'recorded' }, { stepId: 's1a', materialId: 'm2', status: 'pending' }] };
		expect(allPartsScanned(step, scannedKeys(half, { recordedOnly: true }))).toBe(false);
		expect(allPartsScanned(step, scannedKeys(half))).toBe(true);
		expect(scannedKeys(half).has(scanKey('s1a', 'm1'))).toBe(true);
	});

	it('reports status and the first open section from completed steps', () => {
		expect(buildStatus(wi, {})).toEqual({ label: 'Not started', tone: 'idle' });
		const setupDone = { completedSteps: [{ stepId: 's0a' }, { stepId: 's0b' }] };
		expect(buildProgress(wi, setupDone)).toEqual({ done: 2, total: 4 });
		expect(firstOpenSection(wi, setupDone)?.number).toBe(1);
		expect(buildStatus(wi, setupDone)).toEqual({ label: 'In progress · Electronics', tone: 'active' });
		const all = { completedSteps: ['s0a', 's0b', 's1a', 's1b'].map((stepId) => ({ stepId })) };
		expect(buildStatus(wi, all).label).toBe('Complete');
	});

	it('frees the slot of an undone scan, but holds it while the undo is in flight', () => {
		const section = wi.sections[1];
		const undone = { scans: [{ stepId: 's1a', materialId: 'm1', status: 'undone' }] };
		expect(scannedKeys(undone).size).toBe(0);
		const hit = findStepForPart(section, undone, { partDefinitionId: 'pd12' });
		expect(hit.kind === 'found' && hit.material._id).toBe('m1');
		const undoing = { scans: [{ stepId: 's1a', materialId: 'm1', status: 'undoing' }] };
		expect(findStepForPart(section, undoing, { partDefinitionId: 'pd12' }).kind).toBe('already-scanned');
		expect(scannedKeys(undoing, { recordedOnly: true }).size).toBe(0);
		const rescanned = [{ stepId: 's1a', materialId: 'm1', status: 'undone', n: 1 }, { stepId: 's1a', materialId: 'm1', status: 'recorded', n: 2 }];
		expect(liveScan(rescanned, 's1a', 'm1')?.n).toBe(2);
	});

	it('reports cancelled builds as cancelled, and a build whose only scan was undone as not started', () => {
		expect(buildStatus(wi, { status: 'cancelled', completedSteps: [{ stepId: 's0a' }] })).toEqual({ label: 'Cancelled', tone: 'cancelled' });
		expect(buildStatus(wi, { scans: [{ stepId: 's1a', materialId: 'm1', status: 'undone' }] }).label).toBe('Not started');
	});

	it('ignores completed steps that were later deleted from the WI', () => {
		expect(buildProgress(wi, { completedSteps: [{ stepId: 'gone' }, { stepId: 's0a' }] })).toEqual({ done: 1, total: 4 });
	});
});
