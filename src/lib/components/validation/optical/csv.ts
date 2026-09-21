// CSV helpers. Co-located under components/ because src/lib/utils/ is frozen.
//
// The nearest precedent in the repo (validation/thermocouple/history) does a bare
// `row.join(',')`. Do NOT copy that: group names here are free text typed by
// operators, so an unquoted comma shreds the file, and an unescaped leading `=`
// executes as a formula when the file is opened in Excel.

/** Quote/escape one cell, and defuse spreadsheet formula injection. */
export function csvCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	let s = String(value);

	// Formula injection: Excel/Sheets evaluate a cell starting with any of these.
	// Prefixing an apostrophe keeps the text visible but inert.
	if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;

	if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
	return s;
}

export function toCsv(header: string[], rows: Array<Array<unknown>>): string {
	const lines = [header.map(csvCell).join(',')];
	for (const r of rows) lines.push(r.map(csvCell).join(','));
	// CRLF + a UTF-8 BOM keeps Excel happy with non-ASCII group names.
	return '﻿' + lines.join('\r\n');
}

export function downloadCsv(filename: string, content: string): void {
	const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
	const url = URL.createObjectURL(blob);
	const a = document.createElement('a');
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

/** YYYY-MM-DD for filenames. */
export function todayStamp(): string {
	return new Date().toISOString().slice(0, 10);
}
