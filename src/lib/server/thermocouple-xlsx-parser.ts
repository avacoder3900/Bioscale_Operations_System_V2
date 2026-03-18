import * as XLSX from 'xlsx';

export interface ParsedThermocoupleData {
	num: number[];
	channels: {
		ch1: number[];
		ch2: number[];
		ch3: number[];
		ch4: number[];
	};
	rowCount: number;
	fileName?: string;
}

const CHANNEL_NAMES = ['ch1', 'ch2', 'ch3', 'ch4'] as const;

function parseNumber(val: unknown): number | null {
	if (val === null || val === undefined || val === '') return null;
	const n = Number(val);
	return isNaN(n) ? null : n;
}

/**
 * Parse a thermocouple xlsx file, extracting the "num" column and ch1–ch4 channels.
 * Headers are matched case-insensitively. The first sheet is used.
 */
export function parseThermocoupleXlsx(buffer: Buffer | Uint8Array, fileName?: string): ParsedThermocoupleData {
	const workbook = XLSX.read(buffer, { type: 'buffer' });
	const sheetName = workbook.SheetNames[0];
	if (!sheetName) throw new Error('Workbook has no sheets');

	const ws = workbook.Sheets[sheetName];
	const allRows: unknown[][] = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: null });

	if (allRows.length < 2) throw new Error('File must have at least a header row and one data row');

	// Find header row — scan first 10 rows for one containing "num" and at least "ch1"
	let headerRowIdx = -1;
	let colMap: Record<string, number> = {};

	for (let i = 0; i < Math.min(10, allRows.length); i++) {
		const row = allRows[i];
		const map: Record<string, number> = {};
		for (let j = 0; j < row.length; j++) {
			const cell = String(row[j] ?? '').trim().toLowerCase();
			if (cell === 'num') map['num'] = j;
			for (const ch of CHANNEL_NAMES) {
				if (cell === ch || cell === ch.toUpperCase() || cell === `ch ${ch.slice(2)}` || cell === `channel ${ch.slice(2)}`) {
					map[ch] = j;
				}
			}
		}
		if ('num' in map && 'ch1' in map) {
			headerRowIdx = i;
			colMap = map;
			break;
		}
	}

	if (headerRowIdx === -1) {
		throw new Error('Could not find header row with "num" and "ch1" columns. Expected columns: num, ch1, ch2, ch3, ch4');
	}

	const missingChannels = CHANNEL_NAMES.filter(ch => !(ch in colMap));
	if (missingChannels.length > 0) {
		throw new Error(`Missing channel columns: ${missingChannels.join(', ')}`);
	}

	const dataRows = allRows.slice(headerRowIdx + 1);
	const num: number[] = [];
	const channels: Record<string, number[]> = { ch1: [], ch2: [], ch3: [], ch4: [] };

	for (let i = 0; i < dataRows.length; i++) {
		const row = dataRows[i];
		const numVal = parseNumber(row[colMap['num']]);
		if (numVal === null) continue; // skip rows without a valid num value

		num.push(numVal);
		for (const ch of CHANNEL_NAMES) {
			const val = parseNumber(row[colMap[ch]]);
			channels[ch].push(val ?? 0);
		}
	}

	if (num.length === 0) {
		throw new Error('No valid data rows found after header');
	}

	return {
		num,
		channels: channels as ParsedThermocoupleData['channels'],
		rowCount: num.length,
		fileName
	};
}
