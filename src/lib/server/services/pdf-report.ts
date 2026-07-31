/**
 * Minimal styled-report PDF generator.
 *
 * Zero external dependencies (same rationale as r2.ts — no Rollup/Vercel
 * packaging issues): emits PDF 1.4 by hand with the built-in Helvetica fonts.
 * Supports what BIMS-style inventory reports need — stat tiles, section
 * headings, tables with filled header rows, alternating row shading, and
 * highlighted (low-stock) rows. Not a general layout engine.
 */

export interface PdfColumn {
	header: string;
	/** Left edge of the column, in points from the left page edge. */
	x: number;
	/** Cell text longer than this is truncated with '..'. */
	maxChars: number;
}

export interface PdfRow {
	cells: string[];
	/** Shade the row and draw the highlight cell in red (e.g. low stock). */
	highlight?: boolean;
}

export interface PdfSection {
	heading?: string;
	columns: PdfColumn[];
	rows: PdfRow[];
	/** Index of the cell drawn red+bold on highlighted rows (e.g. On Hand). */
	highlightCellIndex?: number;
}

export interface PdfStat {
	label: string;
	value: string;
}

export interface PdfReportSpec {
	title: string;
	/** Small lines under the title (generated-at, applied filters, ...). */
	subtitleLines?: string[];
	/** Summary tiles drawn as boxes under the subtitle (like the BIMS page). */
	stats?: PdfStat[];
	sections: PdfSection[];
	/** Small lines after the last section (totals, notes). */
	footerLines?: string[];
	/** Footer text repeated bottom-left of every page (page number goes right). */
	pageFooter?: string;
	/** US Letter landscape (792x612) instead of portrait (612x792). */
	landscape?: boolean;
}

const LEFT = 40;
const ROW_LEAD = 13;
const BOTTOM_Y = 56;

// Palette (RGB 0..1) loosely matching the BIMS report styling.
const NAVY = '0.13 0.22 0.38';
const GRAY_TEXT = '0.45 0.45 0.5';
const ALT_BG = '0.95 0.95 0.97';
const HILITE_BG = '0.99 0.90 0.90';
const RED = '0.78 0.11 0.11';
const TILE_BG = '0.93 0.95 0.98';
const BLACK = '0 0 0';

/**
 * Compute column positions/widths automatically from content, for callers that
 * supply arbitrary tables (the universal export endpoint). Columns get width
 * proportional to their longest cell (clamped), shrunk to fit the page.
 */
export function autoLayoutColumns(labels: string[], rows: string[][], landscape = true): PdfColumn[] {
	const usable = (landscape ? 792 : 612) - 80;
	const CHAR_W = 4.8;
	const GAP = 10;
	let want = labels.map((l, i) => {
		let m = l.length;
		for (const r of rows) m = Math.max(m, (r[i] ?? '').length);
		return Math.min(Math.max(m, 3), 60);
	});
	const width = (chars: number) => chars * CHAR_W + GAP;
	const total = want.reduce((s, c) => s + width(c), 0);
	if (total > usable) {
		const scale = (usable - labels.length * GAP) / (total - labels.length * GAP);
		want = want.map((c) => Math.max(3, Math.floor(c * scale)));
	}
	const cols: PdfColumn[] = [];
	let x = LEFT;
	labels.forEach((l, i) => {
		cols.push({ header: l, x, maxChars: want[i] });
		x += width(want[i]);
	});
	return cols;
}

/** PDF string escaping; non-ASCII is replaced (built-in fonts are WinAnsi). */
function esc(s: string): string {
	return s
		.replace(/\\/g, '\\\\')
		.replace(/\(/g, '\\(')
		.replace(/\)/g, '\\)')
		.replace(/[^\x20-\x7e]/g, '?');
}

function clip(s: string, maxChars: number): string {
	return s.length <= maxChars ? s : s.slice(0, Math.max(1, maxChars - 2)) + '..';
}

function text(font: 'F1' | 'F2', size: number, x: number, y: number, s: string, color = BLACK): string {
	return `${color} rg BT /${font} ${size} Tf ${x} ${y} Td (${esc(s)}) Tj ET\n`;
}

function rect(x: number, y: number, w: number, h: number, color: string): string {
	return `${color} rg ${x} ${y} ${w} ${h} re f\n`;
}

export function generateReportPdf(spec: PdfReportSpec): Buffer {
	const { title, subtitleLines = [], stats = [], sections, footerLines = [], pageFooter = '' } = spec;
	const PAGE_W = spec.landscape ? 792 : 612;
	const PAGE_H = spec.landscape ? 612 : 792;
	const RIGHT = PAGE_W - 40;

	const pages: string[] = [];
	let stream = '';
	let y = PAGE_H - 58;

	const tableHeader = (sec: PdfSection): void => {
		stream += rect(LEFT - 6, y - 4, RIGHT - LEFT + 12, ROW_LEAD + 4, NAVY);
		for (const c of sec.columns) stream += text('F2', 8.5, c.x, y, clip(c.header, c.maxChars), '1 1 1');
		y -= ROW_LEAD + 2;
	};

	let activeSection: PdfSection | null = null;
	const flushPage = () => {
		pages.push(stream);
		stream = '';
		y = PAGE_H - 50;
		if (activeSection) tableHeader(activeSection);
	};
	const need = (h: number) => {
		if (y - h < BOTTOM_Y) flushPage();
	};

	// --- Title block
	stream += text('F2', 16, LEFT, y, title, NAVY);
	y -= 15;
	for (const line of subtitleLines) {
		stream += text('F1', 8.5, LEFT, y, line, GRAY_TEXT);
		y -= 11;
	}
	y -= 6;

	// --- Stat tiles
	if (stats.length) {
		const gap = 10;
		const tileW = (RIGHT - LEFT - gap * (stats.length - 1)) / stats.length;
		const tileH = 34;
		stats.forEach((s, i) => {
			const x = LEFT + i * (tileW + gap);
			stream += rect(x, y - tileH, tileW, tileH, TILE_BG);
			stream += text('F2', 12, x + 9, y - 16, clip(s.value, Math.floor((tileW - 18) / 6)), NAVY);
			stream += text('F1', 7.5, x + 9, y - 27, clip(s.label, Math.floor((tileW - 18) / 4)), GRAY_TEXT);
		});
		y -= tileH + 14;
	}

	// --- Sections
	for (const sec of sections) {
		need(ROW_LEAD * 4);
		if (sec.heading) {
			stream += text('F2', 11, LEFT, y, sec.heading, NAVY);
			y -= ROW_LEAD + 3;
		}
		activeSection = sec;
		tableHeader(sec);
		sec.rows.forEach((row, i) => {
			need(ROW_LEAD);
			if (row.highlight) stream += rect(LEFT - 6, y - 4, RIGHT - LEFT + 12, ROW_LEAD, HILITE_BG);
			else if (i % 2 === 1) stream += rect(LEFT - 6, y - 4, RIGHT - LEFT + 12, ROW_LEAD, ALT_BG);
			sec.columns.forEach((c, ci) => {
				const hot = row.highlight && ci === sec.highlightCellIndex;
				stream += text(hot ? 'F2' : 'F1', 8.5, c.x, y, clip(row.cells[ci] ?? '', c.maxChars), hot ? RED : BLACK);
			});
			y -= ROW_LEAD;
		});
		activeSection = null;
		y -= 10;
	}

	// --- Footer notes
	if (footerLines.length) {
		need(footerLines.length * ROW_LEAD + 6);
		for (const line of footerLines) {
			stream += text('F1', 8, LEFT, y, line, GRAY_TEXT);
			y -= 11;
		}
	}
	pages.push(stream);

	// Per-page footer: report name left, page number right.
	const paged = pages.map((body, i) => {
		let footer = '';
		if (pageFooter) footer += text('F1', 7.5, LEFT, 34, pageFooter, GRAY_TEXT);
		footer += text('F1', 7.5, RIGHT - 40, 34, `Page ${i + 1} of ${pages.length}`, GRAY_TEXT);
		return body + footer;
	});

	// Object layout: 1 catalog, 2 pages tree, 3 F1, 4 F2, then (page, content) pairs.
	const objects: string[] = [];
	const pageObjNums = paged.map((_, i) => 5 + i * 2);
	objects.push(`<< /Type /Catalog /Pages 2 0 R >>`);
	objects.push(
		`<< /Type /Pages /Kids [${pageObjNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${paged.length} >>`
	);
	objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>`);
	objects.push(`<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>`);
	for (let i = 0; i < paged.length; i++) {
		objects.push(
			`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
				`/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${6 + i * 2} 0 R >>`
		);
		const s = paged[i];
		objects.push(`<< /Length ${Buffer.byteLength(s)} >>\nstream\n${s}endstream`);
	}

	let out = '%PDF-1.4\n';
	const offsets: number[] = [];
	objects.forEach((body, i) => {
		offsets.push(Buffer.byteLength(out));
		out += `${i + 1} 0 obj\n${body}\nendobj\n`;
	});
	const xrefStart = Buffer.byteLength(out);
	out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
	for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
	out +=
		`trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
		`startxref\n${xrefStart}\n%%EOF\n`;

	return Buffer.from(out, 'binary');
}
