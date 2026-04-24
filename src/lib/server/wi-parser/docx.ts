/**
 * DOCX text extractor for Work Instructions.
 *
 * TODO(SPU-MFG-08-deps): `mammoth` is not yet listed in package.json. Until it
 * is added, this function throws. The pure text parser in `extract-parts.ts`
 * still works against raw text passed in by tests or future integrations.
 *
 * When `mammoth` is installed, replace the stub with:
 *
 *   import mammoth from 'mammoth';
 *   const result = await mammoth.extractRawText({ buffer });
 *   return result.value;
 */

export async function extractDocxText(_buffer: Buffer): Promise<string> {
	throw new Error('docx parser not installed — see SPU-MFG-08 notes');
}
