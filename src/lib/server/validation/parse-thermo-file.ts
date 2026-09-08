// Server-side entry point for thermocouple file ingestion.
//
// The operator's spreadsheet is the record: it is posted whole, read here, and
// turned into readings in one place. Nothing parses on the client, so there is
// no second copy of the data that can drift away from the file on screen —
// the defect that recorded SPU 247's measurement against SPU 257.

import * as XLSX from 'xlsx';
import { parseThermoRows, type ThermoReading } from './parse-thermo';

export type { ThermoReading };

export interface ThermoFileParse {
	readings: ThermoReading[];
	/** e.g. "temperature from column B+C, time from column A" — shown to the operator. */
	columnsNote: string;
	rowCount: number;
}

/**
 * Read an .xlsx/.csv export from a bench thermocouple logger.
 *
 * `tzOffsetMinutes` is the recording machine's `Date#getTimezoneOffset()`. The
 * loggers write naive wall-clock text ("14:01:39 2026-09-04"), so without it
 * the same file resolves five hours apart in a Central browser and in a UTC
 * serverless function. Every session already in the database was parsed in a
 * Central browser; passing the operator's real offset keeps new sessions on
 * the same timeline as that history.
 */
export function parseThermoFile(
	bytes: Uint8Array,
	opts: { tzOffsetMinutes?: number } = {}
): ThermoFileParse | { error: string } {
	if (!bytes || bytes.byteLength === 0) {
		return { error: 'That file is empty — re-export it from the logger and try again.' };
	}

	let rows: unknown[][];
	try {
		const workbook = XLSX.read(bytes, { type: 'array' });
		const sheetName = workbook.SheetNames[0];
		if (!sheetName) return { error: 'That workbook has no sheets.' };
		rows = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], { header: 1 });
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		return { error: `Could not read that file as a spreadsheet (.xlsx or .csv): ${detail}` };
	}

	if (!rows || rows.length < 2) {
		return { error: 'That file has no data rows. A logger export has a header row and one row per reading.' };
	}

	const parsed = parseThermoRows(rows, opts.tzOffsetMinutes);
	if (parsed.error) return { error: parsed.error };

	return {
		readings: parsed.readings,
		columnsNote: parsed.columnsNote,
		rowCount: rows.length
	};
}
