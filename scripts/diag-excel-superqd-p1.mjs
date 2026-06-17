// Use exceljs from the research-v2 reference snapshot's node_modules so we
// don't need to install it as a BIMS dep. Read-only — we never write to the
// snapshot folder.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT = path.resolve(__dirname, '..', 'brevitest-research-v2 (refrence 5_17_25)');
const require = createRequire(path.join(SNAPSHOT, 'package.json'));
const ExcelJS = require('exceljs');

const FILE = path.join(SNAPSHOT, 'reference spread sheets', 'Super QD - Phase 1 TEOS (in progress).xlsx');

function cellStr(v) {
	if (v == null) return '';
	if (typeof v === 'object') {
		if ('richText' in v) return v.richText.map((p) => p.text).join('');
		if ('text' in v) return String(v.text);
		if ('result' in v) return String(v.result ?? '');
		if ('formula' in v) return `=${v.formula}`;
	}
	if (v instanceof Date) return v.toISOString().slice(0, 10);
	return String(v).trim();
}

function isLabelish(s) {
	if (!s) return false;
	if (s.length > 80) return false;
	if (/^=?\d+(\.\d+)?$/.test(s)) return false;
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

		const hits = [];
		const maxCol = Math.min(sheet.columnCount, 50);
		const maxRow = Math.min(sheet.rowCount, 500);
		for (let r = 1; r <= maxRow; r++) {
			const row = sheet.getRow(r);
			for (let c = 1; c <= maxCol; c++) {
				const labelCell = row.getCell(c);
				const valCell = row.getCell(c + 1);
				const unitCell = row.getCell(c + 2);
				const label = cellStr(labelCell.value);
				const val = cellStr(valCell.value);
				if (!isLabelish(label)) continue;
				if (!val) continue;
				const formula =
					typeof valCell.value === 'object' && valCell.value && 'formula' in valCell.value
						? `=${valCell.value.formula}`
						: undefined;
				const unitStr = cellStr(unitCell.value);
				hits.push({
					row: r,
					label,
					value: val,
					unit: unitStr && unitStr.length < 12 ? unitStr : undefined,
					formula
				});
			}
		}
		if (hits.length) {
			console.log(`\n  -- label/value pairs (${hits.length}) --`);
			for (const h of hits.slice(0, 250)) {
				const unit = h.unit ? ` ${h.unit}` : '';
				const f = h.formula ? `  ${h.formula}` : '';
				console.log(`  R${h.row}  ${h.label}  =  ${h.value}${unit}${f}`);
			}
		}

		const stepRows = [];
		for (let r = 1; r <= maxRow; r++) {
			const first = cellStr(sheet.getRow(r).getCell(1).value);
			if (/^step\s*\d+/i.test(first) || /^\d+\./.test(first) || /^\d+\)/.test(first)) stepRows.push(r);
		}
		if (stepRows.length) {
			console.log(`\n  -- numbered-step rows (${stepRows.length}) --`);
			for (const r of stepRows.slice(0, 80)) {
				const row = sheet.getRow(r);
				const cells = [];
				for (let c = 1; c <= Math.min(8, sheet.columnCount); c++) {
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
