import mammoth from 'mammoth';
import { nanoid } from 'nanoid';
import { uploadToR2 } from './r2';
import type { FieldDefinition, ParsedPart } from './spu-work-instruction';

export const PARSER_VERSION = '2.0.0';

// Matches "Friendly Name (PT-SPU-NNN) xN" with qty optional. Allows × or x.
const PART_RE = /([^()<>\n]{0,80}?)\(\s*(PT-SPU-\d{3,})\s*\)(?:\s*[x×]\s*(\d+))?/gi;
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

export type ParsedWorkInstruction = {
	title?: string;
	rawContent: string;
	renderedHtml: string;
	parts: ParsedPart[];
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
					try {
						const buf = await image.read();
						const ct: string = image.contentType || 'image/png';
						const ext = (ct.split('/')[1] || 'png').toLowerCase().replace(/[^a-z0-9]/g, '') || 'png';
						const idx = ++imgIndex;
						const key = `wi/${parseId}/img-${String(idx).padStart(3, '0')}.${ext}`;
						const url = await uploadToR2(Buffer.from(buf), key, ct);
						return { src: url, alt: `wi-image-${idx}` };
					} catch (err: any) {
						r2Failures.push(err?.message ?? 'unknown');
						return { src: '', alt: 'r2-upload-failed' };
					}
				})
			}
		);
		if (result.messages?.length) {
			for (const m of result.messages) warnings.push(`mammoth: ${m.message}`);
		}
		if (r2Failures.length) {
			warnings.push(`r2 upload failures: ${r2Failures.length} (${r2Failures[0]})`);
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

	for (const m of rawText.matchAll(ALT_PART_RE)) {
		warnings.push(`Non-PT-SPU reference found: ${m[0]} — confirm if part of build`);
	}

	const { html: htmlWithWidgets, parts } = injectPartWidgets(sanitized, warnings);

	const title = deriveTitle(rawText, file.originalName);
	const totalRequiredScans = parts.reduce((n, p) => n + p.fieldDefinitions.length, 0);

	return {
		title,
		rawContent: rawText,
		renderedHtml: htmlWithWidgets,
		parts,
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
				warnings.push(`${partNumber}: no qty (xN) specified — defaulting to 1`);
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

function buildFieldDefinitions(partNumber: string, quantity: number): FieldDefinition[] {
	const fields: FieldDefinition[] = [];
	for (let n = 1; n <= quantity; n++) {
		fields.push({
			fieldName: `${partNumber}_scan_${n}`.replace(/[^A-Za-z0-9_]/g, '_'),
			fieldLabel: `Scan ${partNumber} (${n} of ${quantity})`,
			fieldType: 'barcode_scan',
			isRequired: true,
			barcodeFieldMapping: partNumber,
			sortOrder: n
		});
	}
	return fields;
}

function renderPreviewWidget(p: {
	anchorId: string;
	partNumber: string;
	partName: string;
	quantity: number;
}): string {
	const inputs: string[] = [];
	for (let i = 1; i <= p.quantity; i++) {
		inputs.push(
			`<div class="bims-scan-widget__input"><label>Scan ${i} of ${p.quantity}</label><input type="text" disabled placeholder="(preview · scan in build page)" /></div>`
		);
	}
	const headerLabel = p.partName ? `${p.partNumber} — ${escapeHtml(p.partName)} · qty ${p.quantity}` : `${p.partNumber} · qty ${p.quantity}`;
	return `<div class="bims-scan-widget" data-anchor="${p.anchorId}" data-part="${p.partNumber}" data-qty="${p.quantity}"><div class="bims-scan-widget__header">${headerLabel}</div><div class="bims-scan-widget__inputs">${inputs.join('')}</div></div>`;
}
