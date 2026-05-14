/**
 * One-shot conversion script — pulls the Brevitest + Fannin chemical
 * inventory xlsx down to two CSVs under data/chemical-inventory/.
 *
 * Run manually whenever the source xlsx changes:
 *   npx tsx scripts/convert-chemical-inventory.ts
 *
 * Source on the Lab Mac:
 *   C:\Users\nicho\Downloads\Brevitest and Fannin Chemical Inventory Final (1).xlsx
 *
 * The xlsx has a single "Chemical Inventory" sheet with a "BREVITEST" banner
 * over rows 0-149 and a "FANNIN" banner above rows 153-208. The script
 * splits on those banners and writes the two halves.
 */
import * as XLSX from 'xlsx';
import * as fs from 'node:fs';
import * as path from 'node:path';

const SRC = 'C:/Users/nicho/Downloads/Brevitest and Fannin Chemical Inventory Final (1).xlsx';
const OUT_DIR = 'data/chemical-inventory';

function cleanHeader(h: any[]): string[] {
	return h.map((c) => String(c).replace(/\s+/g, ' ').trim());
}

function esc(v: unknown): string {
	const s = String(v ?? '');
	if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
	return s;
}

function toCsv(headers: string[], data: any[][]): string {
	const lines = [headers.map(esc).join(',')];
	for (const row of data) {
		const cells = headers.map((_, i) => esc(row[i]));
		lines.push(cells.join(','));
	}
	return lines.join('\n') + '\n';
}

function main() {
	if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

	const buf = fs.readFileSync(SRC);
	const wb = XLSX.read(buf, { type: 'buffer' });
	const sheet = wb.Sheets['Chemical Inventory'];
	if (!sheet) throw new Error('Sheet "Chemical Inventory" missing');
	const rows: any[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

	let fanninIdx = -1;
	for (let i = 0; i < rows.length; i++) {
		if (String((rows[i] as any[])[0] || '').trim().toUpperCase() === 'FANNIN') {
			fanninIdx = i;
			break;
		}
	}
	if (fanninIdx === -1) throw new Error('FANNIN delimiter not found');

	const btHeader = cleanHeader(rows[1]);
	const btData = rows.slice(2, fanninIdx).filter((r) => String(r[0] || '').trim().length > 0);

	const fanninHeader = cleanHeader(rows[fanninIdx + 2]);
	const fanninData = rows
		.slice(fanninIdx + 3)
		.filter((r) => String(r[0] || '').trim().length > 0);

	fs.writeFileSync(path.join(OUT_DIR, 'brevitest.csv'), toCsv(btHeader, btData));
	fs.writeFileSync(path.join(OUT_DIR, 'fannin.csv'), toCsv(fanninHeader, fanninData));

	console.log(`Wrote ${btData.length} Brevitest rows + ${fanninData.length} Fannin rows.`);
}

main();
