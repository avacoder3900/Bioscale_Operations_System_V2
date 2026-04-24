/**
 * PDF text extractor for Work Instructions.
 *
 * TODO(SPU-MFG-08-deps): `pdf-parse` is not yet listed in package.json. Until
 * it is added, this function throws. The pure text parser in
 * `extract-parts.ts` still works against raw text passed in directly.
 *
 * When `pdf-parse` is installed, replace the stub with:
 *
 *   import pdf from 'pdf-parse';
 *   const result = await pdf(buffer);
 *   return result.text;
 */

export async function extractPdfText(_buffer: Buffer): Promise<string> {
	throw new Error('pdf parser not installed — see SPU-MFG-08 notes');
}
