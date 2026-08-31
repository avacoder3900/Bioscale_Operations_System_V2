import mammoth from 'mammoth';
import { nanoid } from 'nanoid';
import { uploadToR2, uploadViaWorker } from './r2';
import type { FieldDefinition, ParsedPart } from './spu-work-instruction';

// 3.3.0 — steps carry a unique stepOrdinal plus the author's printed stepLabel.
// data-step and scan field names are keyed on the ordinal (the author's own
// numbering repeats across sub-steps and restarted sections), and field names
// carry a per-part occurrence index so a step can reference one part twice.
export const PARSER_VERSION = '3.3.0';

// Matches "Friendly Name (PT-SPU-NNN) xN" (or "x N") with qty optional.
// Our SPU WIs author qty as "x1" / "x2" / "x3" — multiplier glued to a small
// integer — and also glue the next part's name on with no whitespace after
// stripTags joins paragraph boundaries (e.g. "x3Cylindrical Magnets"). So:
//   • whitespace between the multiplier and digits is OPTIONAL
//   • the qty is bounded to 1–2 digits, AND the negative lookahead `(?!\d)`
//     refuses to capture when the next character is another digit
// That negative lookahead is what prevents "(PT-SPU-024)x120 tooth pulley"
// from being mis-read as qty=120: greedy `\d{1,2}` tries "12", `(?!\d)` fails
// because the next char is "0"; backtracks to "1", fails again on "2"; whole
// qty group is dropped and we emit a "no qty" warning instead of silent
// corruption. Glued-letter cases like "x3Cylindrical" still match correctly
// because "C" is not a digit.
const PART_RE = /([^()<>\n]{0,80}?)\(\s*(PT-SPU-\d{3,})\s*\)\s*(?:[x×*]\s*(\d{1,2})(?!\d))?/gi;
// Informational-only part families — surfaced as warnings, not turned into widgets.
const ALT_PART_RE = /\b(SBA-SPU|IFU-SPU)-(\d{3,})\b/g;

const ALLOWED_TAGS = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
	'p', 'br', 'hr',
	'strong', 'em', 'u', 'b', 'i', 's', 'strike', 'sub', 'sup', 'code', 'pre',
	'ul', 'ol', 'li',
	'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
	'a', 'img', 'span', 'div', 'blockquote'
]);

type Hit = { partName: string; partNumber: string; quantity: number; segIdx: number };

export type ParsedStep = {
	// Position of the row in the procedure table, 1..N. ALWAYS unique, and the
	// only safe key for identifying a step. Use this for DOM ids, field names,
	// and anything that stores a scan against a step.
	stepOrdinal: number;
	// The author's own numbering, parsed to an integer. NOT unique: "1.1" and
	// "1.2" both yield 1, and a document whose sections restart at 1 repeats it.
	// Kept for display and for backwards compatibility with versions parsed
	// before 3.3.0.
	stepNumber: number;
	// The step-number cell exactly as the operator sees it ("1.1", "Step 4").
	// This is what the printed label must agree with, not stepNumber.
	stepLabel: string;
	title: string;
	content: string;
	contentText: string;
	numCellHtml: string;
	parts: ParsedPart[];
	images: string[];
	fieldDefinitions: FieldDefinition[];
};

export type ParsedWorkInstruction = {
	title?: string;
	rawContent: string;
	renderedHtml: string;
	parts: ParsedPart[];
	steps: ParsedStep[];
	totalRequiredScans: number;
	parserVersion: string;
	warnings: string[];
};

export async function parseSpuWorkInstruction(file: {
	buffer: Buffer;
	mimeType: string;
	originalName: string;
}): Promise<ParsedWorkInstruction> {
	const warnings: string[] = [];
	const lowerName = file.originalName.toLowerCase();
	const isDocx =
		file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		lowerName.endsWith('.docx');

	let rawHtml: string;
	let rawText: string;

	if (isDocx) {
		const parseId = nanoid(8);
		let imgIndex = 0;
		const r2Failures: string[] = [];

		const result = await mammoth.convertToHtml(
			{ buffer: file.buffer },
			{
				convertImage: mammoth.images.imgElement(async (image: any) => {
					const buf = Buffer.from(await image.read());
					const ct: string = image.contentType || 'image/png';
					const ext = (ct.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
					const idx = ++imgIndex;
					const key = `wi/${parseId}/img-${String(idx).padStart(3, '0')}.${ext}`;

					// Try Worker upload first (Vercel-compatible). Fall back to direct S3v4
					// (works in environments without TLS issues), then to inline base64 so
					// the picture is *always* visible on screen even if storage is down.
					try {
						const url = await uploadViaWorker(buf, key, ct);
						return { src: url, alt: `wi-image-${idx}` };
					} catch (workerErr: any) {
						try {
							const url = await uploadToR2(buf, key, ct);
							return { src: url, alt: `wi-image-${idx}` };
						} catch (s3Err: any) {
							r2Failures.push(`img-${idx}: ${workerErr?.message ?? workerErr} / ${s3Err?.message ?? s3Err}`);
							const dataUri = `data:${ct};base64,${buf.toString('base64')}`;
							return { src: dataUri, alt: `wi-image-${idx}` };
						}
					}
				})
			}
		);
		if (result.messages?.length) {
			for (const m of result.messages) warnings.push(`mammoth: ${m.message}`);
		}
		if (r2Failures.length) {
			warnings.push(`r2 upload failures: ${r2Failures.length} embedded inline (${r2Failures[0]})`);
		}
		rawHtml = result.value ?? '';
		const txt = await mammoth.extractRawText({ buffer: file.buffer });
		rawText = txt.value ?? '';
	} else if (file.mimeType === 'application/pdf' || lowerName.endsWith('.pdf')) {
		const mod: any = await import('pdf-parse');
		const PDFParse = mod.PDFParse ?? mod.default?.PDFParse ?? mod.default;
		const data = new Uint8Array(file.buffer);
		const parser = new PDFParse({ data });
		const result: any = await parser.getText();
		rawText = (result?.text ?? '').replace(/\r\n/g, '\n');
		rawHtml = '<div>' + rawText.split(/\n{2,}/).map((p) => `<p>${escapeHtml(p)}</p>`).join('') + '</div>';
		warnings.push('pdf: rendered as plain paragraphs; .docx recommended for layout fidelity');
	} else {
		rawText = file.buffer.toString('utf8');
		rawHtml = `<pre>${escapeHtml(rawText)}</pre>`;
		warnings.push(`unsupported file type ${file.mimeType || file.originalName}; rendered as plain text`);
	}

	const sanitized = sanitizeHtml(rawHtml);
	const cropped = cropToProcedure(sanitized, warnings);

	for (const m of rawText.matchAll(ALT_PART_RE)) {
		warnings.push(`Non-PT-SPU reference found: ${m[0]} — confirm if part of build`);
	}

	let renderedHtml: string;
	let parts: ParsedPart[];
	let steps: ParsedStep[];

	const tableExtraction = extractStepsFromTable(cropped, warnings);
	if (tableExtraction) {
		steps = tableExtraction.steps;
		parts = steps.flatMap((s) => s.parts);
		renderedHtml =
			tableExtraction.preTableHtml +
			renderStepRowsHtml(steps) +
			tableExtraction.postTableHtml;
	} else {
		warnings.push('No procedure table detected — falling back to inline widget render');
		const inline = injectPartWidgets(cropped, warnings);
		renderedHtml = inline.html;
		parts = inline.parts;
		steps = [];
	}

	const title = deriveTitle(rawText, file.originalName);
	const totalRequiredScans = parts.reduce((n, p) => n + p.fieldDefinitions.length, 0);

	return {
		title,
		rawContent: rawText,
		renderedHtml,
		parts,
		steps,
		totalRequiredScans,
		parserVersion: PARSER_VERSION,
		warnings
	};
}

function deriveTitle(text: string, fallback: string): string {
	const firstNonEmpty = text.split(/\r?\n/).find((l) => l.trim().length > 0);
	if (firstNonEmpty && firstNonEmpty.trim().length < 120) return firstNonEmpty.trim();
	return fallback.replace(/\.[a-z]+$/i, '');
}

function escapeHtml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

// Drop everything before the first "Procedure" section header so the rendered
// document starts at the actual build steps. Falls back to the full sanitized
// HTML (with a warning) when no procedure heading is found.
function cropToProcedure(html: string, warnings: string[]): string {
	const headingRe = /<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>/gi;
	const procRe = /^(?:\d+(?:\.\d+)*\.?\s*)?procedure\b/i;
	let m: RegExpExecArray | null;
	while ((m = headingRe.exec(html)) !== null) {
		const text = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
		if (procRe.test(text)) return html.slice(m.index);
	}
	// Fallback: bold paragraph used as a pseudo-heading (e.g. <p><strong>Procedure</strong></p>).
	const boldPRe = /<p\b[^>]*>\s*(?:<(?:strong|b)\b[^>]*>)?([\s\S]*?)(?:<\/(?:strong|b)>)?\s*<\/p>/gi;
	const exactRe = /^(?:\d+(?:\.\d+)*\.?\s*)?procedure\s*:?\s*$/i;
	while ((m = boldPRe.exec(html)) !== null) {
		const text = m[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
		if (exactRe.test(text)) return html.slice(m.index);
	}
	warnings.push('No "Procedure" section heading found — rendered full document');
	return html;
}

// Strip <script>/<style>/<iframe> blocks and event-handler attributes; restrict
// surviving tags to ALLOWED_TAGS. Trusted-author content (only spu:write users
// can upload), so this is allowlist-based, not full DOMPurify.
function sanitizeHtml(html: string): string {
	let s = html;
	s = s.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
	s = s.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
	s = s.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
	s = s.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '');
	s = s.replace(/\s+on[a-z]+\s*=\s*"[^"]*"/gi, '');
	s = s.replace(/\s+on[a-z]+\s*=\s*'[^']*'/gi, '');
	s = s.replace(/(href|src)\s*=\s*"javascript:[^"]*"/gi, '$1="#"');
	s = s.replace(/(href|src)\s*=\s*'javascript:[^']*'/gi, "$1='#'");
	s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (match, tag) => {
		return ALLOWED_TAGS.has(tag.toLowerCase()) ? match : '';
	});
	return s;
}

// Find the first <table> in the cropped Procedure HTML and treat its rows as
// steps. The first cell is the step number; the remaining cells (typically just
// one — the instruction — but possibly more) are concatenated verbatim as the
// instruction HTML so the operator sees exactly what the author wrote. Images
// inside the instruction cell are preserved inline (not relocated to a
// separate image cell).
//
// Returns null if no usable table is found, signalling a fallback render. Also
// returns the HTML before and after the table so non-table content (headings,
// intro paragraphs) renders untouched around the synthesized step rows.
function extractStepsFromTable(
	html: string,
	warnings: string[]
): { steps: ParsedStep[]; preTableHtml: string; postTableHtml: string } | null {
	const tableRe = /<table\b[^>]*>[\s\S]*?<\/table>/i;
	const tableMatch = html.match(tableRe);
	if (!tableMatch) return null;
	const tableStart = tableMatch.index ?? 0;
	const tableEnd = tableStart + tableMatch[0].length;
	const preTableHtml = html.slice(0, tableStart);
	const postTableHtml = html.slice(tableEnd);

	const innerMatch = tableMatch[0].match(/<table\b[^>]*>([\s\S]*?)<\/table>/i);
	const inner = innerMatch ? innerMatch[1] : '';

	const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
	const rawRows: string[] = [];
	let rm: RegExpExecArray | null;
	while ((rm = rowRe.exec(inner)) !== null) rawRows.push(rm[1]);
	if (rawRows.length === 0) return null;

	const cellRe = /<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi;
	const steps: ParsedStep[] = [];
	let stepCounter = 0;

	for (let r = 0; r < rawRows.length; r++) {
		const cells: string[] = [];
		let cm: RegExpExecArray | null;
		cellRe.lastIndex = 0;
		while ((cm = cellRe.exec(rawRows[r])) !== null) cells.push(cm[1]);
		if (cells.length < 2) continue;

		const stepCellHtml = cells[0] ?? '';
		const stepCellText = stripTags(stepCellHtml).trim();
		const numMatch = stepCellText.match(/\d+/);

		// Header row heuristic: no step emitted yet, no number in the step cell,
		// and the step cell reads like a column heading.
		//
		// Anchored on stepCounter, NOT on r === 0: real documents open with a
		// merged single-cell title row (dropped above by `cells.length < 2`), so
		// the actual header lands at r === 1 and used to slip through as step 1.
		// That shifted every synthesized step number by one — WIMF-SPU-01 showed
		// its first instruction as step 2. The step cell must itself contain the
		// heading word, so a real step with an empty number cell is unaffected.
		if (stepCounter === 0 && !numMatch && /step|instruction|picture|image/i.test(stepCellText)) continue;

		stepCounter++;
		// stepOrdinal is the row's position and is guaranteed unique. stepNumber
		// is the author's numbering and is not — see the ParsedStep docs.
		const stepOrdinal = stepCounter;
		const stepNumber = numMatch ? parseInt(numMatch[0], 10) : stepCounter;
		const stepLabel = stepCellText.length > 0 ? stepCellText : String(stepOrdinal);

		// Concatenate every cell after the step-number cell verbatim. Common case
		// is a single instruction cell, but if the author keeps a separate image
		// (or qty) column we want it inline rather than dropped. A literal space
		// between cells keeps "(PT-SPU-001)" and a following "x2" cell from
		// fusing into "(PT-SPU-001)x2" when the regex tries to find the qty.
		const instructionHtml = cells.slice(1).join(' ').trim();
		const instructionText = stripTags(instructionHtml)
			.replace(/&nbsp;/g, ' ')
			.replace(/\s+/g, ' ')
			.trim();

		// Collect any image URLs that live inside the row so /review can still
		// show them, but DO NOT strip them from instructionHtml — they stay where
		// the author put them.
		const imageUrls: string[] = [];
		const imgSrcRe = /<img\b[^>]*\bsrc\s*=\s*"([^"]+)"/gi;
		imgSrcRe.lastIndex = 0;
		let im: RegExpExecArray | null;
		while ((im = imgSrcRe.exec(instructionHtml)) !== null) {
			if (im[1] && !imageUrls.includes(im[1])) imageUrls.push(im[1]);
		}

		// Detect parts in this step's instruction text.
		const parts: ParsedPart[] = [];
		PART_RE.lastIndex = 0;
		let pm: RegExpExecArray | null;
		while ((pm = PART_RE.exec(instructionText)) !== null) {
			const partName = cleanPartName(pm[1]);
			const partNumber = pm[2].toUpperCase();
			let quantity = 1;
			if (pm[3]) {
				const n = parseInt(pm[3], 10);
				if (Number.isFinite(n) && n >= 1 && n <= 999) quantity = n;
			} else {
				warnings.push(`Step ${stepLabel} ${partNumber}: no qty (need "xN" after the part number, e.g. "x2") — defaulting to 1`);
			}
			parts.push({
				anchorId: `anchor-${nanoid(8)}`,
				partNumber,
				partName,
				quantity,
				fieldDefinitions: buildFieldDefinitions(partNumber, quantity)
			});
		}

		const fieldDefinitions = parts.flatMap((p) => p.fieldDefinitions);
		const titleSource = instructionText.split(/[.!?]\s/)[0] ?? instructionText;
		const title = (titleSource.length > 120 ? titleSource.slice(0, 117) + '…' : titleSource) || `Step ${stepLabel}`;

		steps.push({
			stepOrdinal,
			stepNumber,
			stepLabel,
			title,
			content: instructionHtml,
			contentText: instructionText,
			numCellHtml: stepCellHtml,
			parts,
			images: imageUrls,
			fieldDefinitions
		});
	}

	if (steps.length === 0) return null;
	return { steps, preTableHtml, postTableHtml };
}

// Replace block-level tag boundaries with a space FIRST so that
// `<p>A</p><p>B</p>` becomes `A B`, not `AB`. Otherwise paragraph breaks in the
// source .docx glue text together ("picture.Note:", "x3Cylindrical Magnets")
// and downstream regex parsing fails on the merged tokens.
function stripTags(html: string): string {
	return html
		.replace(/<\/?(?:p|div|li|tr|td|th|h[1-6]|br|hr|blockquote|table|thead|tbody|tfoot|ul|ol|pre)\b[^>]*>/gi, ' ')
		.replace(/<[^>]+>/g, '');
}

// Render the procedure as 2-column rows: left = the original step content
// (step-number cell + instruction cell HTML) preserved verbatim from the
// source .docx; right = barcode scan inputs for that step's parts, or a "No
// scans required" chip when the step has no part references.
//
// Each row carries data-required-scans so the viewer's gating script can lock
// subsequent rows until the current row's scans are filled.
function renderStepRowsHtml(steps: ParsedStep[]): string {
	const out: string[] = ['<div class="bims-wi-steps">'];
	for (const step of steps) {
		const numCell = step.numCellHtml && stripTags(step.numCellHtml).trim().length > 0
			? step.numCellHtml
			: `<p>${escapeHtml(step.stepLabel)}</p>`;
		const instructionCell = step.content && step.content.trim().length > 0
			? step.content
			: `<p>${escapeHtml(step.title)}</p>`;

		const scanInputs: string[] = [];
		let totalScans = 0;
		// A step may reference the same part more than once ("one on the left and
		// one on the right"). Those are distinct scans, so the field name carries
		// an occurrence index — without it both inputs would share a `name` and a
		// form post would keep only the last value.
		const seenParts = new Map<string, number>();
		for (const p of step.parts) {
			totalScans++;
			const partKey = p.partNumber.replace(/[^A-Za-z0-9]/g, '_');
			const occurrence = (seenParts.get(partKey) ?? 0) + 1;
			seenParts.set(partKey, occurrence);
			// Keyed on stepOrdinal, never stepNumber: the author's numbering can
			// repeat across sub-steps and restarted sections.
			const fieldName = `step_${step.stepOrdinal}_${partKey}_${occurrence}`;
			const qtyLabel = p.quantity > 1 ? ` × ${p.quantity}` : '';
			scanInputs.push(
				`<div class="bims-wi-step__scan"><label>Scan ${escapeHtml(p.partNumber)}${qtyLabel}</label><input type="text" class="bims-wi-step__scan-input" name="${fieldName}" data-step="${step.stepOrdinal}" data-step-label="${escapeAttr(step.stepLabel)}" data-part="${escapeAttr(p.partNumber)}" data-occurrence="${occurrence}" data-qty="${p.quantity}" data-required="true" placeholder="Scan barcode" autocomplete="off" /></div>`
			);
		}
		const scansBlock = scanInputs.length
			? `<div class="bims-wi-step__scans" data-required-scans="${totalScans}">${scanInputs.join('')}</div>`
			: `<div class="bims-wi-step__scans bims-wi-step__scans--none" data-required-scans="0"><span class="bims-wi-step__no-scans">No scans required</span></div>`;

		out.push(
			`<section class="bims-wi-step" data-step="${step.stepOrdinal}" data-step-label="${escapeAttr(step.stepLabel)}" data-required-scans="${totalScans}"><div class="bims-wi-step__doc"><div class="bims-wi-step__num">${numCell}</div><div class="bims-wi-step__instruction">${instructionCell}</div></div>${scansBlock}</section>`
		);
	}
	out.push('</div>');
	return out.join('');
}

function escapeAttr(s: string): string {
	return s.replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// Walk the sanitized HTML, find every "(PT-SPU-NNN) xN" pattern in TEXT (not
// inside a tag), and insert a preview-mode barcode-scan widget block right
// after the closest enclosing block element (paragraph, list item, or table).
// Each match becomes a ParsedPart entry with N field definitions.
function injectPartWidgets(
	html: string,
	warnings: string[]
): { html: string; parts: ParsedPart[] } {
	const parts: ParsedPart[] = [];

	// Tokenize into <tag> | text segments to avoid matching inside attributes.
	const segments = html.split(/(<[^>]+>)/);
	const hits: Hit[] = [];

	for (let i = 0; i < segments.length; i++) {
		const seg = segments[i];
		if (!seg || seg.startsWith('<')) continue;
		PART_RE.lastIndex = 0;
		let m: RegExpExecArray | null;
		while ((m = PART_RE.exec(seg)) !== null) {
			const partName = cleanPartName(m[1]);
			const partNumber = m[2].toUpperCase();
			const qtyStr = m[3];
			let quantity = 1;
			if (qtyStr) {
				const n = parseInt(qtyStr, 10);
				if (Number.isFinite(n) && n >= 1 && n <= 999) quantity = n;
			} else {
				warnings.push(`${partNumber}: no qty (need "xN" after the part number, e.g. "x2") — defaulting to 1`);
			}
			hits.push({ partName, partNumber, quantity, segIdx: i });
		}
	}

	if (hits.length === 0) return { html, parts: [] };

	// Walk segments to figure out which block element each hit belongs to, so
	// we can splice the widget after the block's closing tag rather than
	// mid-paragraph (which would visually break flow).
	const closeTagAfter = mapHitsToBlockEnd(segments, hits);

	const widgetsByCloseIdx = new Map<number, string[]>();
	for (let i = 0; i < hits.length; i++) {
		const hit = hits[i];
		const anchorId = `anchor-${nanoid(8)}`;
		const fieldDefinitions = buildFieldDefinitions(hit.partNumber, hit.quantity);
		parts.push({
			anchorId,
			partNumber: hit.partNumber,
			partName: hit.partName,
			quantity: hit.quantity,
			fieldDefinitions
		});
		const widgetHtml = renderPreviewWidget({
			anchorId,
			partNumber: hit.partNumber,
			partName: hit.partName,
			quantity: hit.quantity
		});
		const target = closeTagAfter[i];
		const list = widgetsByCloseIdx.get(target) ?? [];
		list.push(widgetHtml);
		widgetsByCloseIdx.set(target, list);
	}

	// Re-assemble, appending widget HTML after every flagged closing tag.
	const out: string[] = [];
	for (let i = 0; i < segments.length; i++) {
		out.push(segments[i]);
		const widgets = widgetsByCloseIdx.get(i);
		if (widgets) for (const w of widgets) out.push(w);
	}

	return { html: out.join(''), parts };
}

const BLOCK_OPEN_RE = /^<(p|li|tr|table|h[1-6]|blockquote|div)\b/i;
const BLOCK_CLOSE_RE = /^<\/(p|li|tr|table|h[1-6]|blockquote|div)\s*>/i;

// For each hit, find the index of the closing tag of its enclosing block.
// If a hit lives inside a <td> / <tr>, we walk OUT to the closing </table>
// so the widget appears below the whole table (per the user's confirmation).
function mapHitsToBlockEnd(segments: string[], hits: Hit[]): number[] {
	const result: number[] = new Array(hits.length).fill(-1);
	for (let h = 0; h < hits.length; h++) {
		const hit = hits[h];
		// Walk backward to find which block opened most recently.
		const openStack: { tag: string; idx: number }[] = [];
		for (let i = 0; i <= hit.segIdx; i++) {
			const seg = segments[i];
			if (!seg || !seg.startsWith('<')) continue;
			const openM = seg.match(BLOCK_OPEN_RE);
			const closeM = seg.match(BLOCK_CLOSE_RE);
			if (openM) openStack.push({ tag: openM[1].toLowerCase(), idx: i });
			else if (closeM) {
				while (openStack.length && openStack[openStack.length - 1].tag !== closeM[1].toLowerCase()) {
					openStack.pop();
				}
				openStack.pop();
			}
		}
		// Pick the outermost block (table > tr > td > p) so widgets appear at
		// the right granularity.
		const enclosing = openStack[openStack.length - 1];
		const targetTag = enclosing
			? openStack.find((s) => s.tag === 'table')?.tag ?? enclosing.tag
			: null;
		if (!targetTag) {
			result[h] = hit.segIdx;
			continue;
		}
		// Walk forward from hit to find the matching close tag of targetTag.
		let depth = 1;
		let cursor = hit.segIdx + 1;
		while (cursor < segments.length) {
			const s = segments[cursor];
			if (s && s.startsWith('<')) {
				const oM = s.match(new RegExp(`^<${targetTag}\\b`, 'i'));
				const cM = s.match(new RegExp(`^</${targetTag}\\s*>`, 'i'));
				if (oM) depth++;
				else if (cM) {
					depth--;
					if (depth === 0) break;
				}
			}
			cursor++;
		}
		result[h] = cursor < segments.length ? cursor : hit.segIdx;
	}
	return result;
}

function cleanPartName(raw: string): string {
	let s = (raw || '').replace(/[\s ]+/g, ' ').trim();
	// Strip up to last sentence-ending punctuation so we don't carry prior sentences.
	const sentenceEnd = Math.max(s.lastIndexOf('. '), s.lastIndexOf('! '), s.lastIndexOf('? '));
	if (sentenceEnd >= 0 && sentenceEnd < s.length - 2) s = s.slice(sentenceEnd + 2);
	// Drop common leading verbs and articles.
	s = s.replace(/^(?:place|insert|attach|install|add|secure|use|the|a|an)\s+/i, '');
	if (s.length > 60) s = s.slice(s.length - 60);
	return s.trim();
}

// One field definition per part — the qty is conveyed by the part's `quantity`
// (and rendered as "× N" in the label). The build page validates the scanned
// barcode against `barcodeFieldMapping` (the expected part number) and
// decrements inventory by N atomically on accept.
function buildFieldDefinitions(partNumber: string, quantity: number): FieldDefinition[] {
	const qtyLabel = quantity > 1 ? ` × ${quantity}` : '';
	return [{
		fieldName: `${partNumber}_scan`.replace(/[^A-Za-z0-9_]/g, '_'),
		fieldLabel: `Scan ${partNumber}${qtyLabel}`,
		fieldType: 'barcode_scan',
		isRequired: true,
		barcodeFieldMapping: partNumber,
		sortOrder: 1
	}];
}

function renderPreviewWidget(p: {
	anchorId: string;
	partNumber: string;
	partName: string;
	quantity: number;
}): string {
	const qtyLabel = p.quantity > 1 ? ` × ${p.quantity}` : '';
	const inputs: string[] = [
		`<div class="bims-scan-widget__input"><label>Scan ${escapeHtml(p.partNumber)}${qtyLabel}</label><input type="text" disabled placeholder="(preview · scan in build page)" /></div>`
	];
	const headerLabel = p.partName ? `${p.partNumber} — ${escapeHtml(p.partName)} · qty ${p.quantity}` : `${p.partNumber} · qty ${p.quantity}`;
	return `<div class="bims-scan-widget" data-anchor="${p.anchorId}" data-part="${p.partNumber}" data-qty="${p.quantity}"><div class="bims-scan-widget__header">${headerLabel}</div><div class="bims-scan-widget__inputs">${inputs.join('')}</div></div>`;
}
