import { describe, it, expect } from 'vitest';
import {
	splitSteps,
	extractPartsFromText,
	expandFieldDefinitions,
	parseRawText
} from './extract-parts.js';

const FIXTURE = `
SPU Assembly Work Instruction — Revision A
This preamble must be ignored.

Step 1: Prepare housing
Install the main housing onto the fixture.
Required: P/N: HSG-001, Qty: 1
Required: P/N: SCREW-4MM, Qty: 4

Step 2: Attach PCB
Place the PCB into the housing.
P/N: PCB-MAIN, Qty: 1

Step 3: Final inspection
Inspect all mating surfaces. No parts required.

STEP 4. Pack unit
Wrap and box. P/N: BOX-A, Qty: 1, P/N: FOAM-A, Qty: 2
`;

describe('splitSteps', () => {
	it('splits raw text into stepped chunks and drops preamble', () => {
		const chunks = splitSteps(FIXTURE);
		expect(chunks).toHaveLength(4);
		expect(chunks.map((c) => c.stepNumber)).toEqual([1, 2, 3, 4]);
		expect(chunks[0].title).toBe('Prepare housing');
		expect(chunks[3].title).toBe('Pack unit');
	});

	it('handles both "Step N:" and "STEP N." conventions', () => {
		const text = 'Step 1: A\nbody A\nSTEP 2. B\nbody B';
		const chunks = splitSteps(text);
		expect(chunks).toHaveLength(2);
		expect(chunks[0].title).toBe('A');
		expect(chunks[1].title).toBe('B');
	});

	it('returns empty when no step headers present', () => {
		expect(splitSteps('no steps here, just text')).toEqual([]);
	});
});

describe('extractPartsFromText', () => {
	it('captures single P/N + Qty pair', () => {
		expect(extractPartsFromText('P/N: ABC-1, Qty: 3')).toEqual([
			{ partNumber: 'ABC-1', quantity: 3 }
		]);
	});

	it('captures multiple pairs on one line', () => {
		const parts = extractPartsFromText('P/N: A-1, Qty: 2, P/N: B-2, Qty: 5');
		expect(parts).toEqual([
			{ partNumber: 'A-1', quantity: 2 },
			{ partNumber: 'B-2', quantity: 5 }
		]);
	});

	it('aggregates duplicate part numbers within the same chunk', () => {
		const parts = extractPartsFromText('P/N: X-1, Qty: 2\nP/N: X-1, Qty: 3');
		expect(parts).toEqual([{ partNumber: 'X-1', quantity: 5 }]);
	});

	it('is case-insensitive on the P/N marker', () => {
		const parts = extractPartsFromText('p/n: abc, qty: 1');
		// part number regex only matches [A-Z0-9-] — lowercase "abc" should
		// still match because /i flag allows the character class to match
		// lowercase too.
		expect(parts).toEqual([{ partNumber: 'abc', quantity: 1 }]);
	});

	it('ignores malformed lines with qty=0 or non-numeric qty', () => {
		expect(extractPartsFromText('P/N: Z-1, Qty: 0')).toEqual([]);
		expect(extractPartsFromText('P/N: Z-1 Qty:')).toEqual([]);
	});
});

describe('expandFieldDefinitions', () => {
	it('emits one barcode_scan field per qty instance', () => {
		const fields = expandFieldDefinitions([{ partNumber: 'ABC-123', quantity: 3 }]);
		expect(fields).toHaveLength(3);
		expect(fields[0].fieldName).toBe('pn_ABC_123_1');
		expect(fields[1].fieldName).toBe('pn_ABC_123_2');
		expect(fields[2].fieldName).toBe('pn_ABC_123_3');
		for (const f of fields) {
			expect(f.fieldLabel).toBe('ABC-123');
			expect(f.fieldType).toBe('barcode_scan');
			expect(f.isRequired).toBe(true);
			expect(f.barcodeFieldMapping).toBe('lotNumber');
		}
		expect(fields.map((f) => f.sortOrder)).toEqual([0, 1, 2]);
	});

	it('continues sortOrder across multiple part requirements', () => {
		const fields = expandFieldDefinitions([
			{ partNumber: 'A', quantity: 2 },
			{ partNumber: 'B', quantity: 1 }
		]);
		expect(fields.map((f) => f.sortOrder)).toEqual([0, 1, 2]);
		expect(fields.map((f) => f.fieldLabel)).toEqual(['A', 'A', 'B']);
	});

	it('respects startingSortOrder offset', () => {
		const fields = expandFieldDefinitions([{ partNumber: 'A', quantity: 2 }], 10);
		expect(fields.map((f) => f.sortOrder)).toEqual([10, 11]);
	});
});

describe('parseRawText (end-to-end)', () => {
	it('produces a structured WI matching the fixture', () => {
		const result = parseRawText(FIXTURE);
		expect(result.steps).toHaveLength(4);

		// Step 1: HSG-001 x1 + SCREW-4MM x4 → 5 fields
		const step1 = result.steps[0];
		expect(step1.stepNumber).toBe(1);
		expect(step1.title).toBe('Prepare housing');
		expect(step1.partRequirements).toEqual([
			{ partNumber: 'HSG-001', quantity: 1 },
			{ partNumber: 'SCREW-4MM', quantity: 4 }
		]);
		expect(step1.fieldDefinitions).toHaveLength(5);
		expect(step1.fieldDefinitions[0].fieldName).toBe('pn_HSG_001_1');
		expect(step1.fieldDefinitions[1].fieldName).toBe('pn_SCREW_4MM_1');
		expect(step1.fieldDefinitions[4].fieldName).toBe('pn_SCREW_4MM_4');

		// Step 2: PCB-MAIN x1 → 1 field
		const step2 = result.steps[1];
		expect(step2.partRequirements).toEqual([{ partNumber: 'PCB-MAIN', quantity: 1 }]);
		expect(step2.fieldDefinitions).toHaveLength(1);

		// Step 3: no parts → no fields
		const step3 = result.steps[2];
		expect(step3.partRequirements).toEqual([]);
		expect(step3.fieldDefinitions).toEqual([]);

		// Step 4: BOX-A x1 + FOAM-A x2 → 3 fields
		const step4 = result.steps[3];
		expect(step4.partRequirements).toEqual([
			{ partNumber: 'BOX-A', quantity: 1 },
			{ partNumber: 'FOAM-A', quantity: 2 }
		]);
		expect(step4.fieldDefinitions).toHaveLength(3);

		// Total expanded barcode_scan fields across all steps = 5 + 1 + 0 + 3
		const totalFields = result.steps.reduce(
			(sum, s) => sum + s.fieldDefinitions.length,
			0
		);
		expect(totalFields).toBe(9);

		// Every expanded field has the required shape
		for (const step of result.steps) {
			for (const f of step.fieldDefinitions) {
				expect(f.fieldType).toBe('barcode_scan');
				expect(f.isRequired).toBe(true);
				expect(f.barcodeFieldMapping).toBe('lotNumber');
			}
		}
	});
});
