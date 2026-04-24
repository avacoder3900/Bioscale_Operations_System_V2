/**
 * Public entry point for the Work Instruction parser.
 *
 * Dispatches on MIME type to the correct extractor (docx or pdf) and then
 * runs the shared pure-text parser to produce a ParsedWI.
 *
 * See PRD-SPU-MFG-UNIFIED.md §4.3 and §8 (SPU-MFG-08).
 */

import { extractDocxText } from './docx.js';
import { extractPdfText } from './pdf.js';
import { parseRawText } from './extract-parts.js';
import type { ParsedWI } from './extract-parts.js';

export type {
	ParsedWI,
	ParsedStep,
	ParsedFieldDefinition,
	ParsedPartRequirement
} from './extract-parts.js';

export { parseRawText } from './extract-parts.js';

const DOCX_MIME_TYPES = new Set<string>([
	'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
	'application/msword'
]);

const PDF_MIME_TYPES = new Set<string>(['application/pdf']);

/**
 * Extract text from the given buffer and parse it into a structured WI.
 *
 * @throws if the mime type is not supported, or if the underlying extractor
 *   dependency is not installed (stubbed paths). Callers should surface these
 *   as `fail(400)` / `fail(500)` in form actions.
 */
export async function parseWorkInstruction(
	buffer: Buffer,
	mimeType: string
): Promise<ParsedWI> {
	const normalized = (mimeType || '').toLowerCase().trim();
	let text: string;
	if (DOCX_MIME_TYPES.has(normalized)) {
		text = await extractDocxText(buffer);
	} else if (PDF_MIME_TYPES.has(normalized)) {
		text = await extractPdfText(buffer);
	} else {
		throw new Error(`Unsupported work instruction mime type: ${mimeType}`);
	}
	return parseRawText(text);
}
