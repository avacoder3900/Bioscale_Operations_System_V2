import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { parseSpuWorkInstruction } from './spu-wi-parser';

/**
 * Builds a real .docx (a zip of OOXML parts) containing a Procedure table, so
 * these tests exercise the true mammoth -> sanitize -> extract -> render path
 * rather than a hand-written HTML shortcut.
 *
 * `rows` is [stepCell, instructionCell][].
 */
async function makeDocx(rows: string[][]): Promise<Buffer> {
	const esc = (s: string) =>
		s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

	const cell = (text: string) =>
		`<w:tc><w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p></w:tc>`;
	const row = (cells: string[]) => `<w:tr>${cells.map(cell).join('')}</w:tr>`;
	const para = (text: string) =>
		`<w:p><w:r><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;

	const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${para('SPU Assembly Work Instruction')}
    ${para('Procedure')}
    <w:tbl>${rows.map(row).join('')}</w:tbl>
  </w:body>
</w:document>`;

	const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`;

	const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;

	const zip = new JSZip();
	zip.file('[Content_Types].xml', contentTypes);
	zip.folder('_rels')!.file('.rels', rels);
	zip.folder('word')!.file('document.xml', documentXml);
	return zip.generateAsync({ type: 'nodebuffer' });
}

function parseDocx(rows: string[][]) {
	return makeDocx(rows).then((buffer) =>
		parseSpuWorkInstruction({
			buffer,
			mimeType:
				'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
			originalName: 'test-wi.docx'
		})
	);
}

/**
 * Splits renderedHtml into one entry per rendered step section, capturing the
 * section's data-step, its declared scan count, and every scan input inside it.
 * This is the "box next to the step" as the operator actually sees it.
 */
function readRenderedSteps(html: string) {
	const sections = [...html.matchAll(/<section class="bims-wi-step"[\s\S]*?<\/section>/g)].map(
		(m) => m[0]
	);
	return sections.map((section) => {
		const dataStep = section.match(/<section class="bims-wi-step" data-step="(\d+)"/)?.[1];
		const dataStepLabel = section.match(/<section[^>]*data-step-label="([^"]*)"/)?.[1];
		const requiredScans = section.match(/<section[^>]*data-required-scans="(\d+)"/)?.[1];
		const numCell = section
			.match(/<div class="bims-wi-step__num">([\s\S]*?)<\/div>/)?.[1]
			?.replace(/<[^>]+>/g, '')
			.trim();
		const inputs = [...section.matchAll(/<input\b[^>]*>/g)].map((i) => i[0]).map((tag) => ({
			name: tag.match(/name="([^"]*)"/)?.[1],
			step: tag.match(/data-step="([^"]*)"/)?.[1],
			part: tag.match(/data-part="([^"]*)"/)?.[1],
			qty: tag.match(/data-qty="([^"]*)"/)?.[1],
			occurrence: tag.match(/data-occurrence="([^"]*)"/)?.[1]
		}));
		return {
			dataStep,
			dataStepLabel,
			requiredScans,
			numCell,
			inputs,
			noScans: /--none/.test(section)
		};
	});
}

const STANDARD_ROWS = [
	['Step', 'Instruction'],
	['1', 'Place the base plate on the fixture. No parts consumed in this step.'],
	['2', 'Install the Heater Block (PT-SPU-001) x2 onto the base.'],
	['3', 'Attach Magnet (PT-SPU-002) x1 and Spring Clip (PT-SPU-003) x3.'],
	['4', 'Fasten the Upper Bracket (PT-SPU-004) and torque to spec.']
];

describe('SPU WI parser — step/scan-box mapping', () => {
	it('maps every scan box to the step it is rendered beside', async () => {
		const parsed = await parseDocx(STANDARD_ROWS);
		const rendered = readRenderedSteps(parsed.renderedHtml);

		// One rendered section per parsed step — nothing dropped, nothing invented.
		expect(rendered.length).toBe(parsed.steps.length);

		for (let i = 0; i < parsed.steps.length; i++) {
			const step = parsed.steps[i];
			const box = rendered[i];

			// The section is tagged with this step's unique ordinal...
			expect(box.dataStep).toBe(String(step.stepOrdinal));
			// ...and the label it advertises is what the left column prints.
			expect(box.dataStepLabel).toBe(step.stepLabel);
			expect(box.numCell).toBe(step.stepLabel);

			// The box declares exactly as many scans as the step has parts.
			expect(box.requiredScans).toBe(String(step.parts.length));
			expect(box.inputs.length).toBe(step.parts.length);

			// Every input carries this step's ordinal, and the parts line up in
			// order with the right quantity.
			for (let p = 0; p < step.parts.length; p++) {
				expect(box.inputs[p].step).toBe(String(step.stepOrdinal));
				expect(box.inputs[p].part).toBe(step.parts[p].partNumber);
				expect(box.inputs[p].qty).toBe(String(step.parts[p].quantity));
			}
		}
	});

	it('numbers steps 1..N and puts the right parts in each', async () => {
		const parsed = await parseDocx(STANDARD_ROWS);

		expect(parsed.steps.map((s) => s.stepNumber)).toEqual([1, 2, 3, 4]);
		expect(parsed.steps.map((s) => s.parts.map((p) => p.partNumber))).toEqual([
			[],
			['PT-SPU-001'],
			['PT-SPU-002', 'PT-SPU-003'],
			['PT-SPU-004']
		]);
		expect(parsed.steps.map((s) => s.parts.map((p) => p.quantity))).toEqual([
			[],
			[2],
			[1, 3],
			[1]
		]);
	});

	it('shows "No scans required" only for the step with no parts', async () => {
		const parsed = await parseDocx(STANDARD_ROWS);
		const rendered = readRenderedSteps(parsed.renderedHtml);

		expect(rendered.map((r) => r.noScans)).toEqual([true, false, false, false]);
	});

	it('keeps totalRequiredScans and the flat parts list consistent with the steps', async () => {
		const parsed = await parseDocx(STANDARD_ROWS);

		const perStep = parsed.steps.reduce((n, s) => n + s.parts.length, 0);
		expect(parsed.totalRequiredScans).toBe(perStep);
		expect(parsed.parts.map((p) => p.partNumber)).toEqual(
			parsed.steps.flatMap((s) => s.parts.map((p) => p.partNumber))
		);
	});

	it('gives every scan box a unique field name', async () => {
		const parsed = await parseDocx(STANDARD_ROWS);
		const names = readRenderedSteps(parsed.renderedHtml).flatMap((r) =>
			r.inputs.map((i) => i.name)
		);

		expect(names.length).toBe(new Set(names).size);
	});

	it('warns when a part has no explicit quantity', async () => {
		const parsed = await parseDocx(STANDARD_ROWS);

		expect(parsed.warnings.some((w) => w.includes('PT-SPU-004') && w.includes('no qty'))).toBe(
			true
		);
	});

	it('preserves author numbering verbatim, including gaps', async () => {
		const parsed = await parseDocx([
			['Step', 'Instruction'],
			['1', 'Install Heater (PT-SPU-001) x1.'],
			['3', 'Install Magnet (PT-SPU-002) x1.'],
			['7', 'Install Clip (PT-SPU-003) x1.']
		]);
		const rendered = readRenderedSteps(parsed.renderedHtml);

		// The author's numbering is preserved for display, gaps and all...
		expect(parsed.steps.map((s) => s.stepNumber)).toEqual([1, 3, 7]);
		expect(parsed.steps.map((s) => s.stepLabel)).toEqual(['1', '3', '7']);
		expect(rendered.map((r) => r.numCell)).toEqual(['1', '3', '7']);
		expect(rendered.map((r) => r.dataStepLabel)).toEqual(['1', '3', '7']);

		// ...while data-step is the dense row ordinal, which is what the scan
		// boxes are keyed on.
		expect(parsed.steps.map((s) => s.stepOrdinal)).toEqual([1, 2, 3]);
		expect(rendered.map((r) => r.dataStep)).toEqual(['1', '2', '3']);
	});

	it('reads the number out of a prose cell like "Step 1"', async () => {
		const parsed = await parseDocx([
			['Step', 'Instruction'],
			['Step 1', 'Install Heater (PT-SPU-001) x1.'],
			['Step 2', 'Install Magnet (PT-SPU-002) x1.']
		]);

		expect(parsed.steps.map((s) => s.stepNumber)).toEqual([1, 2]);
	});
});

/**
 * Regression tests for three mapping defects found by audit on 2026-08-31 and
 * fixed in parser 3.3.0. The fix separates two things the parser used to
 * conflate:
 *
 *   stepOrdinal — row position, 1..N, ALWAYS unique. Keys data-step and the
 *                 scan field names.
 *   stepLabel   — what the operator actually sees in the left column ("1.1").
 *                 Carried on data-step-label.
 *
 * Field names additionally carry a per-part occurrence index so one step can
 * reference the same part twice.
 */
describe('SPU WI parser — step/scan mapping (3.3.0 regressions)', () => {
	// extractStepsFromTable takes the FIRST run of digits in the number cell, so
	// "1.1" and "1.2" both collapse to stepNumber 1. The ordinal keeps them
	// distinct, and the label is what the left column prints.
	it('sub-step numbering: ordinal stays unique, label matches the printed number', async () => {
		const parsed = await parseDocx([
			['Step', 'Instruction'],
			['1.1', 'Install Heater (PT-SPU-001) x1.'],
			['1.2', 'Install Magnet (PT-SPU-002) x1.'],
			['2', 'Install Clip (PT-SPU-003) x1.']
		]);
		const rendered = readRenderedSteps(parsed.renderedHtml);

		// The author's own numbering still collapses "1.1"/"1.2" to 1 — that is
		// the documented meaning of stepNumber, not a bug.
		expect(parsed.steps.map((s) => s.stepNumber)).toEqual([1, 1, 2]);

		// The ordinal is what identifies a step, and it is unique.
		expect(parsed.steps.map((s) => s.stepOrdinal)).toEqual([1, 2, 3]);
		expect(rendered.map((r) => r.dataStep)).toEqual(['1', '2', '3']);

		// The label advertised on the box is exactly what the operator reads in
		// the left column.
		expect(parsed.steps.map((s) => s.stepLabel)).toEqual(['1.1', '1.2', '2']);
		expect(rendered.map((r) => r.dataStepLabel)).toEqual(rendered.map((r) => r.numCell));
		expect(rendered.map((r) => r.numCell)).toEqual(['1.1', '1.2', '2']);

		// Each box still holds the part its own row declares.
		expect(rendered.map((r) => r.inputs.map((i) => i.part))).toEqual([
			['PT-SPU-001'],
			['PT-SPU-002'],
			['PT-SPU-003']
		]);
	});

	// Field name used to be `step_<n>_<partNumber>`, which was not unique when
	// one step consumes the same part in two places ("one on the left and one on
	// the right"): both inputs rendered with an identical `name`, so a form post
	// would keep only the last value.
	it('same part twice in one step gets unique field names', async () => {
		const parsed = await parseDocx([
			['Step', 'Instruction'],
			['1', 'Install Heater (PT-SPU-001) x1 on the left and Heater (PT-SPU-001) x1 on the right.']
		]);
		const rendered = readRenderedSteps(parsed.renderedHtml);
		const names = rendered.flatMap((r) => r.inputs.map((i) => i.name));

		expect(names.length).toBe(2);
		expect(new Set(names).size).toBe(2);
		expect(names).toEqual(['step_1_PT_SPU_001_1', 'step_1_PT_SPU_001_2']);

		// Both boxes belong to the same step and are distinguished by occurrence.
		expect(rendered[0].inputs.map((i) => i.occurrence)).toEqual(['1', '2']);
		expect(rendered[0].requiredScans).toBe('2');
	});

	// The header heuristic used to be anchored on `r === 0`. WIMF-SPU-01 opens
	// with a merged single-cell title row, which pushes the real header to row 1,
	// so the header was emitted as step 1 and every subsequent step was numbered
	// one too high.
	it('skips the column header even when a merged title row precedes it', async () => {
		const parsed = await parseDocx([
			['Assembly Procedure'], // merged title row — one cell, dropped
			['Step', 'Instructions', 'Image (For reference only)'],
			['', 'Wipe the work surface with 70% alcohol wipes.'],
			['', 'Install Heater (PT-SPU-001) x1.']
		]);
		const rendered = readRenderedSteps(parsed.renderedHtml);

		// Two real steps, not three, and the first one is step 1.
		expect(parsed.steps.length).toBe(2);
		expect(parsed.steps.map((s) => s.stepOrdinal)).toEqual([1, 2]);
		expect(parsed.steps.map((s) => s.stepNumber)).toEqual([1, 2]);
		expect(rendered.map((r) => r.numCell)).toEqual(['1', '2']);
		expect(parsed.steps[0].contentText).toContain('Wipe the work surface');

		// The header text never becomes a step.
		expect(parsed.steps.map((s) => s.stepLabel)).not.toContain('Step');
	});

	// A document with two numbered sections that each restart at 1 used to
	// produce duplicate data-step values across different sections.
	it('restarted numbering does not produce duplicate data-step values', async () => {
		const parsed = await parseDocx([
			['Step', 'Instruction'],
			['1', 'Section A: Install Heater (PT-SPU-001) x1.'],
			['2', 'Section A: Install Magnet (PT-SPU-002) x1.'],
			['1', 'Section B: Install Clip (PT-SPU-003) x1.'],
			['2', 'Section B: Install Screw (PT-SPU-004) x1.']
		]);
		const rendered = readRenderedSteps(parsed.renderedHtml);
		const steps = rendered.map((r) => r.dataStep);

		expect(new Set(steps).size).toBe(steps.length);
		expect(steps).toEqual(['1', '2', '3', '4']);

		// The operator still sees the document's own restarted numbering...
		expect(rendered.map((r) => r.numCell)).toEqual(['1', '2', '1', '2']);
		expect(rendered.map((r) => r.dataStepLabel)).toEqual(['1', '2', '1', '2']);

		// ...and every scan field name is still distinct across the two sections.
		const names = rendered.flatMap((r) => r.inputs.map((i) => i.name));
		expect(new Set(names).size).toBe(names.length);
	});
});
