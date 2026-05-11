/**
 * Equipment datasheet lookup — used by the lookup_equipment_datasheet Ask BIMS
 * tool. Vite bundles the canonical CSVs from data/equipment-datasheets/ at
 * build time so the tool works on Vercel serverless without runtime FS.
 *
 * PDF parsing is deliberately out of scope for this phase (per
 * docs/ask-bims-markdown-context.md). Each equipment row carries a
 * `Datasheet URL` field that the agent can surface as a clickable manufacturer
 * link — that's the practical "where to learn more" path for now.
 *
 * The BT file has a banner row + sub-header layout; the Fannin file is single
 * header. Both are detected by scanning the first ~5 rows for the literal
 * `Tag #` cell, then everything below is data.
 */

import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

// Vite bundles the CSVs at build time via import.meta.glob. Under raw Node
// (e.g. `npx tsx scripts/test-ask-bims.ts`), .glob isn't a function — fall back
// to a synchronous read from process.cwd()/data/equipment-datasheets/.
function loadCsvsFromFs(): Record<string, string> {
	const root = nodePath.resolve(process.cwd(), 'data/equipment-datasheets');
	const out: Record<string, string> = {};
	if (!nodeFs.existsSync(root)) return out;
	for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
			out['/data/equipment-datasheets/' + entry.name] = nodeFs.readFileSync(
				nodePath.join(root, entry.name),
				'utf8'
			);
		}
	}
	return out;
}

const CSV_FILES: Record<string, string> =
	typeof (import.meta as unknown as { glob?: unknown }).glob === 'function'
		? (import.meta.glob('/data/equipment-datasheets/*.csv', {
				query: '?raw',
				import: 'default',
				eager: true
		  }) as Record<string, string>)
		: loadCsvsFromFs();

export interface EquipmentRow {
	source: string; // bundled filename, e.g. 'BT' or 'Fannin'
	tag: string; // 'Tag #' value (e.g. 'B-01', 'F-12')
	fields: Record<string, string>; // every non-empty header→value pair
	datasheetUrl: string | null;
}

export interface EquipmentLookupResult {
	matches: EquipmentRow[];
	totalReturned: number;
	truncated: boolean;
	totalAvailable: number;
	corpusFiles: string[];
	queryNormalized: string;
	timedOut: boolean;
}

const TIMEOUT_MS = 500;
const RESULTS_CAP = 10;
const MIN_QUERY_LEN = 2;

interface ParsedCsv {
	headers: string[];
	rows: string[][];
	rowCount: number;
}

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"' && line[i + 1] === '"') {
				cur += '"';
				i++;
			} else if (ch === '"') {
				inQuotes = false;
			} else {
				cur += ch;
			}
		} else if (ch === '"') {
			inQuotes = true;
		} else if (ch === ',') {
			out.push(cur);
			cur = '';
		} else {
			cur += ch;
		}
	}
	out.push(cur);
	return out;
}

function parseCsv(content: string): ParsedCsv {
	const lines = content.split(/\r?\n/);
	let headerIdx = -1;
	for (let i = 0; i < Math.min(8, lines.length); i++) {
		const cells = parseCsvLine(lines[i]);
		const first = (cells[0] ?? '').trim().toLowerCase();
		if (first === 'tag #' || first === 'tag#' || first === 'tag') {
			headerIdx = i;
			break;
		}
	}
	if (headerIdx === -1) {
		return { headers: [], rows: [], rowCount: 0 };
	}
	const headers = parseCsvLine(lines[headerIdx]).map((h) => h.trim());
	const rows: string[][] = [];
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const raw = lines[i];
		if (!raw.trim()) continue;
		const cells = parseCsvLine(raw);
		// Skip rows that look like sub-headers (first cell empty + most cells non-data).
		if (!cells[0]?.trim()) continue;
		rows.push(cells);
	}
	return { headers, rows, rowCount: rows.length };
}

interface CachedFile {
	source: string;
	parsed: ParsedCsv;
}

let _cache: CachedFile[] | null = null;

function loadCorpus(): CachedFile[] {
	if (_cache) return _cache;
	const out: CachedFile[] = [];
	for (const [path, content] of Object.entries(CSV_FILES)) {
		const filename = path.split('/').pop() ?? path;
		const source = filename.replace(/\.csv$/i, '');
		out.push({ source, parsed: parseCsv(content) });
	}
	_cache = out;
	return out;
}

function rowToEquipment(source: string, headers: string[], cells: string[]): EquipmentRow {
	const fields: Record<string, string> = {};
	for (let i = 0; i < headers.length; i++) {
		const key = headers[i];
		if (!key) continue;
		const val = (cells[i] ?? '').trim();
		if (val) fields[key] = val;
	}
	const tag = fields['Tag #'] ?? fields['Tag#'] ?? fields['Tag'] ?? '';
	const datasheetUrl = fields['Datasheet URL'] || fields['DatasheetURL'] || null;
	return { source, tag, fields, datasheetUrl };
}

export function lookupEquipment(equipmentName: string): EquipmentLookupResult {
	const query = (equipmentName ?? '').trim();
	const corpus = loadCorpus();
	const corpusFiles = corpus.map((c) => c.source);
	const result: EquipmentLookupResult = {
		matches: [],
		totalReturned: 0,
		truncated: false,
		totalAvailable: 0,
		corpusFiles,
		queryNormalized: query.toLowerCase(),
		timedOut: false
	};
	if (query.length < MIN_QUERY_LEN) return result;

	const startedAt = Date.now();
	const lower = query.toLowerCase();
	let totalMatches = 0;
	const collected: EquipmentRow[] = [];

	for (const file of corpus) {
		if (Date.now() - startedAt > TIMEOUT_MS) {
			result.timedOut = true;
			break;
		}
		const headerLowers = file.parsed.headers.map((h) => h.toLowerCase());
		for (const cells of file.parsed.rows) {
			// Match against any cell — covers equipment name, tag, location, notes.
			let matched = false;
			for (let i = 0; i < cells.length; i++) {
				if ((cells[i] ?? '').toLowerCase().includes(lower)) {
					matched = true;
					break;
				}
			}
			if (!matched) continue;
			totalMatches++;
			if (collected.length < RESULTS_CAP) {
				collected.push(rowToEquipment(file.source, file.parsed.headers, cells));
			}
		}
		// Suppress an unused-var warning for headerLowers (kept for future ranked
		// matching — e.g., weight matches in the Equipment column higher).
		void headerLowers;
	}

	result.matches = collected;
	result.totalReturned = collected.length;
	result.totalAvailable = totalMatches;
	result.truncated = totalMatches > collected.length;
	return result;
}
