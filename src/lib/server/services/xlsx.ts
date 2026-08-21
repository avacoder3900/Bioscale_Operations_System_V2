/**
 * Minimal .xlsx workbook writer.
 *
 * Zero external dependencies (same rationale as r2.ts/pdf-report.ts): emits a
 * ZIP (stored entries, hand-rolled CRC32) containing SpreadsheetML with inline
 * strings and native numeric cells, so Excel can sort/sum the numbers. Good
 * for tabular reports; not a general spreadsheet engine (no styles/formulas).
 */

export type XlsxCell = string | number | null | undefined;

export interface XlsxSheet {
	name: string;
	rows: XlsxCell[][];
}

export const XLSX_CONTENT_TYPE =
	'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

// ---------------------------------------------------------------- ZIP layer

const CRC_TABLE = (() => {
	const t = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf: Buffer): number {
	let c = 0xffffffff;
	for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
	return {
		time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
		date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
	};
}

/** Build a ZIP with stored (uncompressed) entries. */
function buildZip(entries: { name: string; data: Buffer }[], now: Date): Buffer {
	const { time, date } = dosDateTime(now);
	const locals: Buffer[] = [];
	const centrals: Buffer[] = [];
	let offset = 0;

	for (const e of entries) {
		const name = Buffer.from(e.name, 'utf8');
		const crc = crc32(e.data);
		const local = Buffer.alloc(30);
		local.writeUInt32LE(0x04034b50, 0);
		local.writeUInt16LE(20, 4); // version needed
		local.writeUInt16LE(0, 6); // flags
		local.writeUInt16LE(0, 8); // method: stored
		local.writeUInt16LE(time, 10);
		local.writeUInt16LE(date, 12);
		local.writeUInt32LE(crc, 14);
		local.writeUInt32LE(e.data.length, 18);
		local.writeUInt32LE(e.data.length, 22);
		local.writeUInt16LE(name.length, 26);
		local.writeUInt16LE(0, 28);
		locals.push(local, name, e.data);

		const central = Buffer.alloc(46);
		central.writeUInt32LE(0x02014b50, 0);
		central.writeUInt16LE(20, 4); // version made by
		central.writeUInt16LE(20, 6); // version needed
		central.writeUInt16LE(0, 8);
		central.writeUInt16LE(0, 10);
		central.writeUInt16LE(time, 12);
		central.writeUInt16LE(date, 14);
		central.writeUInt32LE(crc, 16);
		central.writeUInt32LE(e.data.length, 20);
		central.writeUInt32LE(e.data.length, 24);
		central.writeUInt16LE(name.length, 28);
		// extra/comment/disk/attrs all zero
		central.writeUInt32LE(offset, 42);
		centrals.push(central, name);

		offset += 30 + name.length + e.data.length;
	}

	const centralStart = offset;
	const centralSize = centrals.reduce((s, b) => s + b.length, 0);
	const eocd = Buffer.alloc(22);
	eocd.writeUInt32LE(0x06054b50, 0);
	eocd.writeUInt16LE(entries.length, 8);
	eocd.writeUInt16LE(entries.length, 10);
	eocd.writeUInt32LE(centralSize, 12);
	eocd.writeUInt32LE(centralStart, 16);
	return Buffer.concat([...locals, ...centrals, eocd]);
}

// ------------------------------------------------------------- XLSX layer

function xmlEsc(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

function colLetter(i: number): string {
	let s = '';
	let n = i;
	do {
		s = String.fromCharCode(65 + (n % 26)) + s;
		n = Math.floor(n / 26) - 1;
	} while (n >= 0);
	return s;
}

function sheetXml(rows: XlsxCell[][]): string {
	const out: string[] = [
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
		'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'
	];
	rows.forEach((row, ri) => {
		out.push(`<row r="${ri + 1}">`);
		row.forEach((cell, ci) => {
			if (cell === null || cell === undefined || cell === '') return;
			const ref = `${colLetter(ci)}${ri + 1}`;
			if (typeof cell === 'number' && Number.isFinite(cell)) {
				out.push(`<c r="${ref}"><v>${cell}</v></c>`);
			} else {
				out.push(`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xmlEsc(String(cell))}</t></is></c>`);
			}
		});
		out.push('</row>');
	});
	out.push('</sheetData></worksheet>');
	return out.join('');
}

/** Excel sheet names: max 31 chars, no [ ] : * ? / \ , unique, non-empty. */
function sanitizeSheetNames(sheets: XlsxSheet[]): string[] {
	const used = new Set<string>();
	return sheets.map((s, i) => {
		let name = (s.name || `Sheet${i + 1}`).replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || `Sheet${i + 1}`;
		let candidate = name;
		let n = 2;
		while (used.has(candidate.toLowerCase())) candidate = `${name.slice(0, 28)} ${n++}`;
		used.add(candidate.toLowerCase());
		return candidate;
	});
}

export function buildXlsx(sheets: XlsxSheet[], now = new Date()): Buffer {
	const names = sanitizeSheetNames(sheets);

	const contentTypes =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
		'<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
		'<Default Extension="xml" ContentType="application/xml"/>' +
		'<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
		sheets
			.map(
				(_, i) =>
					`<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
			)
			.join('') +
		'</Types>';

	const rootRels =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		'<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
		'</Relationships>';

	const workbook =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
		names.map((n, i) => `<sheet name="${xmlEsc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
		'</sheets></workbook>';

	const workbookRels =
		'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
		'<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
		sheets
			.map(
				(_, i) =>
					`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`
			)
			.join('') +
		'</Relationships>';

	const entries = [
		{ name: '[Content_Types].xml', data: Buffer.from(contentTypes, 'utf8') },
		{ name: '_rels/.rels', data: Buffer.from(rootRels, 'utf8') },
		{ name: 'xl/workbook.xml', data: Buffer.from(workbook, 'utf8') },
		{ name: 'xl/_rels/workbook.xml.rels', data: Buffer.from(workbookRels, 'utf8') },
		...sheets.map((s, i) => ({
			name: `xl/worksheets/sheet${i + 1}.xml`,
			data: Buffer.from(sheetXml(s.rows), 'utf8')
		}))
	];

	return buildZip(entries, now);
}
