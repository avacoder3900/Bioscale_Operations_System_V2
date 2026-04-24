/**
 * Pure text-to-structure parser for Work Instruction documents.
 *
 * Given raw extracted text (from a .docx or .pdf), this module:
 *   1. Splits the text into steps using the step-boundary regex.
 *   2. Extracts `P/N: <partNumber>, Qty: <n>` tuples per step.
 *   3. Expands each qty into `n` barcode_scan field definitions
 *      (one per expected part instance).
 *
 * This file has NO runtime deps — it is pure, testable, and must work on
 * raw text so that the docx/pdf extractors can remain swappable stubs.
 *
 * See PRD-SPU-MFG-UNIFIED.md §4.3 and §8 (SPU-MFG-08).
 */

export type ParsedFieldDefinition = {
	fieldName: string;
	fieldLabel: string;
	fieldType: 'barcode_scan';
	isRequired: true;
	sortOrder: number;
	barcodeFieldMapping: 'lotNumber';
};

export type ParsedPartRequirement = {
	partNumber: string;
	quantity: number;
};

export type ParsedStep = {
	stepNumber: number;
	title: string;
	content: string;
	fieldDefinitions: ParsedFieldDefinition[];
	partRequirements: ParsedPartRequirement[];
};

export type ParsedWI = {
	steps: ParsedStep[];
};

// Default regex for "P/N: XYZ-123, Qty: 2" (case-insensitive).
// Captures partNumber (allowing [A-Z0-9-]) and the integer qty.
const PART_REGEX = /P\/N[:\s]+([A-Z0-9-]+)[\s,]+Qty[:\s]+(\d+)/gi;

// Step-boundary detector: matches lines like
//   "Step 1: Prepare the housing"
//   "STEP 2. Attach baseplate"
//   "Step  12 - Final QA"
const STEP_BOUNDARY = /^\s*(?:Step|STEP)\s+(\d+)[.:\s-]+(.+)$/;

/**
 * Sanitize a part number for use in a fieldName ident.
 * Replaces non-alphanumerics with underscores.
 */
function sanitize(partNumber: string): string {
	return partNumber.replace(/[^A-Za-z0-9]/g, '_');
}

/**
 * Split raw extracted text into step chunks (header + body).
 * Lines that don't match a step boundary are appended to the most recent
 * step's content. Pre-step preamble is discarded.
 */
export function splitSteps(text: string): Array<{ stepNumber: number; title: string; content: string }> {
	const lines = text.split(/\r?\n/);
	const steps: Array<{ stepNumber: number; title: string; contentLines: string[] }> = [];

	for (const line of lines) {
		const m = line.match(STEP_BOUNDARY);
		if (m) {
			const stepNumber = parseInt(m[1], 10);
			const title = m[2].trim();
			steps.push({ stepNumber, title, contentLines: [] });
		} else if (steps.length > 0) {
			steps[steps.length - 1].contentLines.push(line);
		}
	}

	return steps.map((s) => ({
		stepNumber: s.stepNumber,
		title: s.title,
		content: s.contentLines.join('\n').trim()
	}));
}

/**
 * Extract part/qty pairs from a chunk of text using the part regex.
 * Aggregates identical part numbers (sums their quantities).
 */
export function extractPartsFromText(text: string): ParsedPartRequirement[] {
	const agg = new Map<string, number>();
	// Reset lastIndex between runs — PART_REGEX has /g flag.
	PART_REGEX.lastIndex = 0;
	let match: RegExpExecArray | null;
	while ((match = PART_REGEX.exec(text)) !== null) {
		const partNumber = match[1].trim();
		const qty = parseInt(match[2], 10);
		if (!partNumber || !Number.isFinite(qty) || qty <= 0) continue;
		agg.set(partNumber, (agg.get(partNumber) ?? 0) + qty);
	}
	return [...agg.entries()].map(([partNumber, quantity]) => ({ partNumber, quantity }));
}

/**
 * Expand part requirements into one `barcode_scan` field definition per
 * expected instance (qty=3 → 3 fields).
 */
export function expandFieldDefinitions(
	parts: ParsedPartRequirement[],
	startingSortOrder = 0
): ParsedFieldDefinition[] {
	const fields: ParsedFieldDefinition[] = [];
	let sortOrder = startingSortOrder;
	for (const p of parts) {
		const safe = sanitize(p.partNumber);
		for (let i = 1; i <= p.quantity; i++) {
			fields.push({
				fieldName: `pn_${safe}_${i}`,
				fieldLabel: p.partNumber,
				fieldType: 'barcode_scan',
				isRequired: true,
				sortOrder: sortOrder++,
				barcodeFieldMapping: 'lotNumber'
			});
		}
	}
	return fields;
}

/**
 * End-to-end: raw text → structured ParsedWI.
 */
export function parseRawText(text: string): ParsedWI {
	const chunks = splitSteps(text);
	const steps: ParsedStep[] = chunks.map((chunk) => {
		// Search the entire step body (including the title line, in case the
		// part specifier appears there) for part/qty tuples.
		const haystack = `${chunk.title}\n${chunk.content}`;
		const partRequirements = extractPartsFromText(haystack);
		const fieldDefinitions = expandFieldDefinitions(partRequirements);
		return {
			stepNumber: chunk.stepNumber,
			title: chunk.title,
			content: chunk.content,
			fieldDefinitions,
			partRequirements
		};
	});
	return { steps };
}
