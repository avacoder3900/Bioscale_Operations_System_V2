import mammoth from 'mammoth';

// Parser for the Device Assembly (SPU) Work Instruction .docx.
//
// Document shape it understands (see WIMF With Sections.docx):
//   PURPOSE / SCOPE / RESPONSIBILITIES / DEFINITIONS AND ACRONYMS / REFERENCES   ← h1 front matter
//   PROCEDURE                                                                   ← h1
//     "Cleaning and Setup:"           ← paragraph → section 0 (setup)
//     "Materials:" + 2-col table      ← section materials table
//     Step | Instructions | Photo table
//     "Subassembly #1: Bottom (…)"    ← bold paragraph → section 1
//     Step | Instructions | Photo table (materials are italic bullets "Name (PT-SPU-044) x1")
//
// The parser is DB-free: images are handed to `storeImage` (R2 / Mongo /
// inline — the caller decides) and part numbers are resolved to
// PartDefinition ids by the service layer.

export const DEVICE_WI_PARSER_VERSION = '1.0.0';

export type ParsedImage = { url: string; alt: string; storage: 'r2' | 'mongo' | 'inline' | 'external' };
export type ParsedMaterial = {
	kind: 'part' | 'tool' | 'aid' | 'supply';
	partNumber: string | null;
	name: string;
	quantity: number;
	unit: string;
	deductFromInventory: boolean;
	notes: string;
	rawText: string;
};
export type ParsedStep = {
	stepNumber: number;
	title: string;
	instructionsHtml: string;
	instructionsText: string;
	images: ParsedImage[];
	materials: ParsedMaterial[];
	requiresEsd: boolean;
	dhrFields: string[];
};
export type ParsedSection = {
	type: 'setup' | 'subassembly';
	number: number;
	title: string;
	notesHtml: string;
	materialsHtml: string;
	steps: ParsedStep[];
};
export type ParsedDeviceWI = {
	title: string;
	assemblyNumber: string;
	frontMatter: {
		purposeHtml: string;
		scopeHtml: string;
		responsibilitiesHtml: string;
		definitions: string[];
		references: string[];
		generalNotesHtml: string;
	};
	sections: ParsedSection[];
	imageCount: number;
	parserVersion: string;
	warnings: string[];
};

export type StoreImageFn = (
	buf: Buffer,
	contentType: string,
	index: number
) => Promise<{ url: string; storage: ParsedImage['storage'] }>;

export const DEFAULT_SUBASSEMBLY_COUNT = 5;

// ───────────────────────────── HTML helpers ─────────────────────────────

const ALLOWED_TAGS = new Set([
	'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr',
	'strong', 'em', 'u', 'b', 'i', 's', 'strike', 'sub', 'sup', 'code', 'pre',
	'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th',
	'img', 'span', 'div', 'blockquote', 'a'
]);
const ALLOWED_ATTRS = new Set(['src', 'alt', 'colspan', 'rowspan', 'href', 'title']);

/** Strip scripts, event handlers and unknown tags. Safe for {@html}. */
export function sanitizeHtml(html: string): string {
	let out = html.replace(/<!--[\s\S]*?-->/g, '');
	out = out.replace(/<(script|style|iframe|object|embed)\b[\s\S]*?<\/\1>/gi, '');
	out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g, (whole, tag: string, attrs: string) => {
		const t = tag.toLowerCase();
		if (!ALLOWED_TAGS.has(t)) return '';
		if (whole.startsWith('</')) return `</${t}>`;
		const kept: string[] = [];
		const attrRe = /([a-zA-Z-]+)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/g;
		let m: RegExpExecArray | null;
		while ((m = attrRe.exec(attrs)) !== null) {
			const name = m[1].toLowerCase();
			if (!ALLOWED_ATTRS.has(name)) continue;
			let val = m[2];
			if (val.startsWith('"') || val.startsWith("'")) val = val.slice(1, -1);
			if ((name === 'src' || name === 'href') && /^\s*javascript:/i.test(val)) continue;
			kept.push(`${name}="${val.replace(/"/g, '&quot;')}"`);
		}
		const selfClose = t === 'img' || t === 'br' || t === 'hr' ? ' /' : '';
		return `<${t}${kept.length ? ' ' + kept.join(' ') : ''}${selfClose}>`;
	});
	// Mammoth emits empty bookmark anchors — drop them.
	out = out.replace(/<a>\s*<\/a>/g, '');
	return out;
}

export function decodeEntities(s: string): string {
	return s
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;|&apos;/g, "'")
		.replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function stripTags(html: string): string {
	return decodeEntities(
		html
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|li|tr|h[1-6]|div)>/gi, '\n')
			.replace(/<[^>]+>/g, '')
	)
		.replace(/ /g, ' ')
		.replace(/[ \t]+/g, ' ')
		.replace(/\s*\n\s*/g, '\n')
		.trim();
}

type Block = { tag: string; html: string; inner: string; attrs: string };

/** Find index just past the matching close tag for the element opening at `openStart`. */
function findMatchingClose(html: string, openStart: number, tag: string): number {
	const re = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
	re.lastIndex = openStart;
	let depth = 0;
	let m: RegExpExecArray | null;
	while ((m = re.exec(html)) !== null) {
		if (m[1] === '/') {
			depth--;
			if (depth === 0) return m.index + m[0].length;
		} else {
			depth++;
		}
	}
	return html.length;
}

/** Split flat mammoth HTML into top-level blocks (h1-6, p, table, ul, ol). */
export function splitTopLevelBlocks(html: string): Block[] {
	const blocks: Block[] = [];
	const openRe = /<(h[1-6]|p|table|ul|ol)\b([^>]*)>/gi;
	let pos = 0;
	while (pos < html.length) {
		openRe.lastIndex = pos;
		const m = openRe.exec(html);
		if (!m) break;
		const tag = m[1].toLowerCase();
		const end = findMatchingClose(html, m.index, tag);
		const whole = html.slice(m.index, end);
		const innerStart = m.index + m[0].length;
		const closeLen = tag.length + 3;
		const inner = html.slice(innerStart, Math.max(innerStart, end - closeLen));
		blocks.push({ tag, html: whole, inner, attrs: m[2] ?? '' });
		pos = end;
	}
	return blocks;
}

function extractChildren(html: string, tag: string): { html: string; inner: string; attrs: string }[] {
	const out: { html: string; inner: string; attrs: string }[] = [];
	const re = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
	let pos = 0;
	while (pos < html.length) {
		re.lastIndex = pos;
		const m = re.exec(html);
		if (!m) break;
		const end = findMatchingClose(html, m.index, tag);
		const innerStart = m.index + m[0].length;
		out.push({ html: html.slice(m.index, end), inner: html.slice(innerStart, end - (tag.length + 3)), attrs: m[1] ?? '' });
		pos = end;
	}
	return out;
}

/** Rows of a table (direct rows only — nested tables are skipped). */
function tableRows(tableHtml: string): string[][] {
	// Blank out nested tables so their rows are not picked up twice.
	const inner = tableHtml.replace(/^<table\b[^>]*>/i, '').replace(/<\/table>\s*$/i, '');
	let flat = inner;
	for (const nested of extractChildren(inner, 'table')) flat = flat.replace(nested.html, '');
	const rows: string[][] = [];
	for (const tr of extractChildren(flat, 'tr')) {
		const cells: string[] = [];
		const cellRe = /<(td|th)\b([^>]*)>/gi;
		let pos = 0;
		while (pos < tr.inner.length) {
			cellRe.lastIndex = pos;
			const m = cellRe.exec(tr.inner);
			if (!m) break;
			const tag = m[1].toLowerCase();
			const end = findMatchingClose(tr.inner, m.index, tag);
			cells.push(tr.inner.slice(m.index + m[0].length, end - (tag.length + 3)));
			pos = end;
		}
		rows.push(cells);
	}
	return rows;
}

// ───────────────────────────── material parsing ─────────────────────────────

const MATERIAL_CODE_RE = /^(.*?)\s*\(\s*((?:[A-Z]{2,4}-[A-Z]{2,4}-\d{2,}[A-Z]?)|manufacturing aid|supply|tool)\s*\)\s*(.*)$/i;
const KNOWN_UNITS = new Set(['ea', 'each', 'pc', 'pcs', 'mm', 'cm', 'm', 'in', 'ft', 'g', 'kg', 'mg', 'ml', 'l', 'ul', 'drop', 'drops', 'strip', 'strips', 'sheet', 'sheets', 'roll', 'rolls', 'oz', 'pair', 'pairs', 'set', 'sets']);
const QTY_RE = /^[x×*]\s*([\d.]+(?:\/\d+)?)\s*([A-Za-z]+)?\s*(.*)$/i;

export function parseMaterialLine(raw: string): ParsedMaterial | null {
	const text = raw.replace(/\s+/g, ' ').trim();
	const m = MATERIAL_CODE_RE.exec(text);
	if (!m) return null;
	const name = m[1].trim().replace(/[\s:–-]+$/, '');
	const code = m[2].trim();
	const rest = m[3].trim();
	if (!name) return null;

	let kind: ParsedMaterial['kind'] = 'part';
	let partNumber: string | null = null;
	const upper = code.toUpperCase();
	if (/^MANUFACTURING AID$/i.test(code) || upper === 'TOOL') kind = upper === 'TOOL' ? 'tool' : 'aid';
	else if (/^SUPPLY$/i.test(code)) kind = 'supply';
	else {
		partNumber = upper;
		if (upper.startsWith('TOOL-')) kind = 'tool';
	}

	let quantity = 1;
	let unit = 'ea';
	let notes = rest;
	const q = QTY_RE.exec(rest);
	if (q) {
		const num = q[1].includes('/') ? Number(q[1].split('/')[0]) / Number(q[1].split('/')[1]) : Number(q[1]);
		if (Number.isFinite(num) && num > 0) quantity = num;
		const maybeUnit = (q[2] ?? '').toLowerCase();
		if (maybeUnit && KNOWN_UNITS.has(maybeUnit)) {
			unit = maybeUnit;
			notes = (q[3] ?? '').trim();
		} else {
			// "x1 need new pt number" — the word after the qty is a note, not a unit.
			notes = [q[2], q[3]].filter(Boolean).join(' ').trim();
		}
	}
	if (unit === 'drop') unit = 'drops';
	if (unit === 'pc' || unit === 'pcs' || unit === 'each') unit = 'ea';

	return {
		kind,
		partNumber,
		name,
		quantity,
		unit,
		deductFromInventory: kind === 'part',
		notes,
		rawText: text
	};
}

/** Pull material bullets out of an instructions cell; returns cleaned html + materials. */
function extractMaterials(cellHtml: string): { html: string; materials: ParsedMaterial[] } {
	const materials: ParsedMaterial[] = [];
	let html = cellHtml;
	for (const ul of extractChildren(cellHtml, 'ul')) {
		const items = extractChildren(ul.inner, 'li');
		const keep: string[] = [];
		for (const li of items) {
			// Skip nested-list items (procedural sub-bullets) — only leaf bullets are materials.
			if (/<ul\b|<ol\b/i.test(li.inner)) { keep.push(li.html); continue; }
			const mat = parseMaterialLine(stripTags(li.inner));
			if (mat) materials.push(mat);
			else keep.push(li.html);
		}
		if (keep.length === items.length) continue; // nothing extracted
		const replacement = keep.length ? `<ul>${keep.join('')}</ul>` : '';
		html = html.replace(ul.html, replacement);
	}
	return { html, materials };
}

// ───────────────────────────── step parsing ─────────────────────────────

const IMG_RE = /<img\b[^>]*>/gi;

function extractImages(html: string): { html: string; images: ParsedImage[] } {
	const images: ParsedImage[] = [];
	const cleaned = html.replace(IMG_RE, (tag) => {
		const src = /src\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '';
		if (!src) return '';
		let alt = decodeEntities(/alt\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ?? '');
		alt = alt.replace(/\s*Description automatically generated\s*/i, '').replace(/\s+/g, ' ').trim();
		if (/^(wi-image-\d+|image|img_\d+\.jpg)$/i.test(alt)) alt = '';
		const storage: ParsedImage['storage'] = src.startsWith('data:') ? 'inline' : src.includes('/api/device-assembly/images/') ? 'mongo' : 'r2';
		images.push({ url: src, alt, storage });
		return '';
	});
	return { html: cleaned, images };
}

function tidyHtml(html: string): string {
	return html
		.replace(/<p>\s*(?:&nbsp;|\s|<em>\s*<\/em>|<strong>\s*<\/strong>)*<\/p>/gi, '')
		.replace(/<ul>\s*<\/ul>/gi, '')
		.replace(/\s{2,}/g, ' ')
		.trim();
}

function deriveStepTitle(text: string): string {
	const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
	// Prefer the first line that isn't a bare note.
	const line = lines.find((l) => !/^note\s*:/i.test(l)) ?? lines[0] ?? '';
	const sentence = line.split(/(?<=[.!?])\s/)[0] ?? line;
	const t = sentence.replace(/^note\s*:\s*/i, '').trim();
	return t.length > 90 ? t.slice(0, 87).trimEnd() + '…' : t;
}

function isHeaderRow(cells: string[]): boolean {
	const texts = cells.map((c) => stripTags(c).toLowerCase());
	return texts.some((t) => /^step$/.test(t)) && texts.some((t) => /^instructions?$/.test(t));
}

function parseStepTable(tableHtml: string, startNumber: number, warnings: string[]): { steps: ParsedStep[]; notesHtml: string } {
	const steps: ParsedStep[] = [];
	let notesHtml = '';
	let counter = startNumber;
	for (const cells of tableRows(tableHtml)) {
		if (!cells.length) continue;
		if (isHeaderRow(cells)) continue;
		const joinedText = stripTags(cells.join(' '));
		const hasImg = cells.some((c) => IMG_RE.test(c));
		IMG_RE.lastIndex = 0;
		if (!joinedText && !hasImg) continue;
		if (/^for non-conforming material/i.test(joinedText)) continue;
		if (/^(name|quantity)$/i.test(joinedText)) continue;

		let numCell = '';
		let instrCells: string[] = [];
		let photoCell = '';
		if (cells.length >= 3) {
			numCell = cells[0];
			instrCells = cells.slice(1, -1);
			photoCell = cells[cells.length - 1];
		} else if (cells.length === 2) {
			instrCells = [cells[0]];
			photoCell = cells[1];
		} else {
			instrCells = [cells[0]];
		}

		let instrHtml = instrCells.join('');
		const photoImgs = extractImages(photoCell);
		const inlineImgs = extractImages(instrHtml);
		instrHtml = inlineImgs.html;
		const { html: noMats, materials } = extractMaterials(instrHtml);
		instrHtml = tidyHtml(sanitizeHtml(noMats));
		const photoText = stripTags(photoImgs.html);
		// Photo-cell captions/notes ("Add photo of filter") belong with the step text.
		if (photoText && !/^n\/?a$/i.test(photoText)) {
			instrHtml += `<p class="photo-note"><em>Photo note: ${photoText.replace(/</g, '&lt;')}</em></p>`;
		}
		const instructionsText = stripTags(instrHtml);
		const images = [...inlineImgs.images, ...photoImgs.images];
		if (!instructionsText && !images.length && !materials.length) continue;
		// A row that is only a "Note:" with no parts or pictures is a section-level note, not a step.
		if (/^note\s*:/i.test(instructionsText) && !images.length && !materials.length && instructionsText.split('\n').length <= 2) {
			notesHtml += instrHtml;
			continue;
		}

		const numText = stripTags(numCell);
		const explicit = /\d+/.exec(numText);
		const stepNumber = explicit ? Number(explicit[0]) : counter + 1;
		counter = stepNumber;

		const dhrFields: string[] = [];
		const dhrRe = /enter\s+(?:all\s+numbers[^.]*?as\s+the\s+)?(?:the\s+)?([A-Z][A-Za-z0-9/\- ]{2,60}?)\s+(?:serial\s+number|s\/n)/gi;
		let dm: RegExpExecArray | null;
		while ((dm = dhrRe.exec(instructionsText)) !== null) {
			const f = dm[1].replace(/\s+/g, ' ').trim();
			if (f && !dhrFields.includes(f)) dhrFields.push(f);
		}
		if (/(?:barcode scanner and motion board) serial number/i.test(instructionsText)) {
			for (const f of ['Barcode Scanner', 'Motion Board']) if (!dhrFields.includes(f)) dhrFields.push(f);
		}

		steps.push({
			stepNumber,
			title: deriveStepTitle(instructionsText),
			instructionsHtml: instrHtml,
			instructionsText,
			images,
			materials,
			requiresEsd: /esd protection shall be worn/i.test(instructionsText),
			dhrFields
		});
	}
	if (!steps.length) warnings.push('A procedure table produced no steps');
	return { steps, notesHtml };
}

function isStepTable(tableHtml: string): boolean {
	return tableRows(tableHtml).some(isHeaderRow);
}

// ───────────────────────────── document assembly ─────────────────────────────

const FRONT_HEADINGS: Record<string, 'purpose' | 'scope' | 'responsibilities' | 'definitions' | 'references' | 'procedure'> = {
	purpose: 'purpose',
	scope: 'scope',
	responsibilities: 'responsibilities',
	'definitions and acronyms': 'definitions',
	definitions: 'definitions',
	acronyms: 'definitions',
	references: 'references',
	procedure: 'procedure'
};

type FrontKey = (typeof FRONT_HEADINGS)[string];
function headingKey(text: string): FrontKey | null {
	const t = text.toLowerCase().replace(/^\d+(\.\d+)*\.?\s*/, '').replace(/[:.]+$/, '').trim();
	return Object.prototype.hasOwnProperty.call(FRONT_HEADINGS, t) ? FRONT_HEADINGS[t] : null;
}

const SUBASSEMBLY_RE = /^sub-?\s*assembly\s*#?\s*(\d+)\s*[:\-–—]?\s*(.*)$/i;
const SETUP_RE = /^(cleaning\s*(and|&)\s*setup|setup|preparation|prep)\b/i;

function isBoldParagraph(block: Block): boolean {
	const inner = block.inner.trim();
	return /^<strong>[\s\S]*<\/strong>$/i.test(inner) || /^<b>[\s\S]*<\/b>$/i.test(inner);
}

export function buildFromHtml(rawHtml: string, warnings: string[]): Omit<ParsedDeviceWI, 'imageCount' | 'parserVersion' | 'warnings'> {
	const blocks = splitTopLevelBlocks(rawHtml);
	const frontMatter: ParsedDeviceWI['frontMatter'] = {
		purposeHtml: '', scopeHtml: '', responsibilitiesHtml: '', definitions: [], references: [], generalNotesHtml: ''
	};
	let assemblyNumber = '';
	let current: FrontKey | null = null;
	let i = 0;

	// ---- front matter: everything before PROCEDURE
	for (; i < blocks.length; i++) {
		const b = blocks[i];
		if (/^h[1-6]$/.test(b.tag)) {
			const text = stripTags(b.inner);
			const key = headingKey(text);
			if (key) {
				current = key;
				if (key === 'procedure') { i++; break; }
				continue;
			}
			// Non-section headings under DEFINITIONS / REFERENCES are the items themselves.
			if (current === 'definitions') { if (text) frontMatter.definitions.push(text); continue; }
			if (current === 'references') {
				if (text) frontMatter.references.push(text);
				const asm = /assembly number\s*:?\s*([A-Z]{2}-[A-Z]{2,4}-\d{3,})/i.exec(text);
				if (asm) assemblyNumber = asm[1].toUpperCase();
				continue;
			}
		}
		const html = sanitizeHtml(b.html);
		if (current === 'purpose') frontMatter.purposeHtml += html;
		else if (current === 'scope') frontMatter.scopeHtml += html;
		else if (current === 'responsibilities') frontMatter.responsibilitiesHtml += html;
		else if (current === 'definitions') { const t = stripTags(b.inner); if (t) frontMatter.definitions.push(...t.split('\n')); }
		else if (current === 'references') { const t = stripTags(b.inner); if (t) frontMatter.references.push(...t.split('\n')); }
	}
	if (current !== 'procedure') {
		warnings.push('No PROCEDURE heading found — treating the whole document as the procedure');
		i = 0;
	}

	// ---- procedure: sections + step tables
	const sections: ParsedSection[] = [];
	let section: ParsedSection | null = null;
	let expectMaterialsTable = false;
	let nextSubNumber = 1;

	const ensureSection = (): ParsedSection => {
		if (!section) {
			section = { type: 'subassembly', number: nextSubNumber++, title: `Sub-Assembly ${nextSubNumber - 1}`, notesHtml: '', materialsHtml: '', steps: [] };
			sections.push(section);
		}
		return section;
	};
	const startSection = (s: ParsedSection) => { section = s; sections.push(s); expectMaterialsTable = false; };

	for (; i < blocks.length; i++) {
		const b = blocks[i];
		const text = stripTags(b.inner);

		if (b.tag === 'table') {
			if (expectMaterialsTable) {
				ensureSection().materialsHtml += sanitizeHtml(b.html);
				expectMaterialsTable = false;
			} else if (isStepTable(b.html)) {
				const sec = ensureSection();
				const last = sec.steps.length ? sec.steps[sec.steps.length - 1].stepNumber : 0;
				const parsed = parseStepTable(b.html, last, warnings);
				sec.steps.push(...parsed.steps);
				sec.notesHtml += parsed.notesHtml;
			} else {
				ensureSection().notesHtml += sanitizeHtml(b.html);
			}
			continue;
		}

		if (!text) continue;

		if (/^h[1-6]$/.test(b.tag) || b.tag === 'p') {
			const sub = SUBASSEMBLY_RE.exec(text);
			if (sub) {
				const n = Number(sub[1]);
				nextSubNumber = Math.max(nextSubNumber, n + 1);
				startSection({ type: 'subassembly', number: n, title: sub[2].trim() || `Sub-Assembly ${n}`, notesHtml: '', materialsHtml: '', steps: [] });
				continue;
			}
			if (/^materials?\s*:?$/i.test(text)) { expectMaterialsTable = true; continue; }
			if (/^notes?\s*:/i.test(text)) {
				const html = sanitizeHtml(b.html);
				if (section) (section as ParsedSection).notesHtml += html; else frontMatter.generalNotesHtml += html;
				continue;
			}
			const short = text.length < 100 && !/[.!?]$/.test(text.replace(/:$/, ''));
			if (short && (SETUP_RE.test(text) || /:$/.test(text) || isBoldParagraph(b) || /^h[1-6]$/.test(b.tag))) {
				const title = text.replace(/:$/, '').trim();
				if (SETUP_RE.test(title) && !sections.some((s) => s.type === 'setup')) {
					startSection({ type: 'setup', number: 0, title, notesHtml: '', materialsHtml: '', steps: [] });
				} else {
					const n = nextSubNumber++;
					startSection({ type: 'subassembly', number: n, title, notesHtml: '', materialsHtml: '', steps: [] });
				}
				continue;
			}
			// Loose paragraph inside a section → section notes.
			const html = sanitizeHtml(b.html);
			if (section) (section as ParsedSection).notesHtml += html; else frontMatter.generalNotesHtml += html;
			continue;
		}

		// Lists / other blocks → notes
		const html = sanitizeHtml(b.html);
		if (section) (section as ParsedSection).notesHtml += html; else frontMatter.generalNotesHtml += html;
	}

	// ---- pad to the default five sub-assemblies, sort by number
	const subNumbers = new Set(sections.filter((s) => s.type === 'subassembly').map((s) => s.number));
	for (let n = 1; n <= DEFAULT_SUBASSEMBLY_COUNT; n++) {
		if (!subNumbers.has(n)) sections.push({ type: 'subassembly', number: n, title: `Sub-Assembly ${n}`, notesHtml: '', materialsHtml: '', steps: [] });
	}
	sections.sort((a, b) => a.number - b.number);

	const totalSteps = sections.reduce((n, s) => n + s.steps.length, 0);
	if (!totalSteps) warnings.push('No steps were extracted from the document');

	return {
		title: 'SPU Assembly Work Instruction',
		assemblyNumber,
		frontMatter,
		sections
	};
}

// ───────────────────────────── entry point ─────────────────────────────

export async function parseDeviceAssemblyWI(
	file: { buffer: Buffer; mimeType: string; originalName: string },
	storeImage: StoreImageFn
): Promise<ParsedDeviceWI> {
	const warnings: string[] = [];
	const lowerName = file.originalName.toLowerCase();
	const isDocx =
		file.mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
		lowerName.endsWith('.docx');
	if (!isDocx) throw new Error('Only .docx files are supported for the SPU Assembly Work Instruction');

	let imgIndex = 0;
	const storeFailures: string[] = [];
	const result = await mammoth.convertToHtml(
		{ buffer: file.buffer },
		{
			styleMap: [
				"p[style-name='Heading 1'] => h1:fresh",
				"p[style-name='Heading 2'] => h2:fresh",
				"p[style-name='Heading 3'] => h3:fresh"
			],
			convertImage: mammoth.images.imgElement(async (image: any) => {
				const buf = Buffer.from(await image.read());
				const ct: string = image.contentType || 'image/png';
				const idx = ++imgIndex;
				try {
					const stored = await storeImage(buf, ct, idx);
					return { src: stored.url, alt: `wi-image-${idx}` };
				} catch (err: any) {
					storeFailures.push(`img-${idx}: ${err?.message ?? err}`);
					return { src: `data:${ct};base64,${buf.toString('base64')}`, alt: `wi-image-${idx}` };
				}
			})
		}
	);
	for (const m of result.messages ?? []) warnings.push(`mammoth: ${m.message}`);
	if (storeFailures.length) warnings.push(`${storeFailures.length} image(s) embedded inline because storage failed (${storeFailures[0]})`);

	const built = buildFromHtml(result.value ?? '', warnings);
	return { ...built, imageCount: imgIndex, parserVersion: DEVICE_WI_PARSER_VERSION, warnings };
}
