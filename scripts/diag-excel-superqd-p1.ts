/**
 * Dumps every parameter, material row, and step from the SuperQD Phase 1
 * Excel SOP so we can diff against the BIMS template.
 *
 * Run: npx tsx scripts/diag-excel-superqd-p1.ts
 */
import ExcelJS from 'exceljs';
import path from 'node:path';

const FILE = path.resolve(
	'brevitest-research-v2 (refrence 5_17_25)',
	'reference spread sheets',
	'Super QD - Phase 1 TEOS (in progress).xlsx'
);

function cellStr(v: ExcelJS.CellValue): string {
	if (v == null) return '';
	if (typeof v === 'object') {
		if ('richText' in v) return (v as any).richText.map((p: any) => p.text).join('');
		if ('text' in v) return String((v as any).text);
		if ('result' in v) return String((v as any).result ?? '');
		if ('formula' in v) return `=${(v as any).formula}`;
	}
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return String(v).trim();
}

function isLabelish(s: string): boolean {
	if (!s) return false;
	if (s.length > 80) return false;
	if (/^\d+(\.\d+)?$/.test(s)) return false;
	return /[A-Za-z]/.test(s);
}

async function main() {
	const wb = new ExcelJS.Workbook();
	await wb.xlsx.readFile(FILE);

	console.log('================================================================');
	console.log(`File: ${path.basename(FILE)}`);
	console.log(`Sheets: ${wb.worksheets.map((s) => s.name).join(', ')}`);
	console.log('================================================================');

	for (const sheet of wb.worksheets) {
		console.log(`\n###### SHEET: ${sheet.name} ######`);
		console.log(`Rows: ${sheet.rowCount}  Cols: ${sheet.columnCount}`);

		// Find label/value pairs — heuristic: text cell followed by a numeric cell
		// in the same row.
		const labelValueHits: Array<{ row: number; label: string; value: string; unit?: string; formula?: string }> = [];
		for (let r = 1; r <= sheet.rowCount; r++) {
			const row = sheet.getRow(r);
			for (let c = 1; c <= sheet.columnCount; c++) {
				const labelCell = row.getCell(c);
				const valCell = row.getCell(c + 1);
				const unitCell = row.getCell(c + 2);
				const label = cellStr(labelCell.value);
				const val = cellStr(valCell.value);
				if (!isLabelish(label)) continue;
				if (!val) continue;
				const formula =
					typeof valCell.value === 'object' && valCell.value && 'formula' in (valCell.value as any)
						? `=${(valCell.value as any).formula}`
						: undefined;
				const unitStr = cellStr(unitCell.value);
				labelValueHits.push({
					row: r,
					label,
					value: val,
					unit: unitStr && unitStr.length < 12 ? unitStr : undefined,
					formula
				});
			}
		}

		if (labelValueHits.length) {
			console.log(`\n  -- label/value pairs (${labelValueHits.length}) --`);
			for (const h of labelValueHits.slice(0, 200)) {
				const unit = h.unit ? ` ${h.unit}` : '';
				const f = h.formula ? `  ${h.formula}` : '';
				console.log(`  R${h.row}  ${h.label}  =  ${h.value}${unit}${f}`);
			}
		}

		// Detect numbered step blocks (rows that start with "Step N" or "N. ...")
		const stepRows: number[] = [];
		for (let r = 1; r <= sheet.rowCount; r++) {
			const first = cellStr(sheet.getRow(r).getCell(1).value);
			if (/^step\s*\d+/i.test(first) || /^\d+\./.test(first) || /^[\d]+\)/.test(first)) {
				stepRows.push(r);
			}
		}
		if (stepRows.length) {
			console.log(`\n  -- numbered-step rows (${stepRows.length}) --`);
			for (const r of stepRows.slice(0, 60)) {
				const row = sheet.getRow(r);
				const cells: string[] = [];
				for (let c = 1; c <= Math.min(6, sheet.columnCount); c++) {
					const v = cellStr(row.getCell(c).value);
					if (v) cells.push(v);
				}
				console.log(`  R${r}  ${cells.join('  |  ')}`);
			}
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
