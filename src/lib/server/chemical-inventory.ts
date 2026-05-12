/**
 * Chemical inventory lookup — used by the lookup_chemical Ask BIMS tool.
 * Mirrors the equipment-datasheets module pattern: import.meta.glob with a
 * Node fs fallback for the test harness, in-memory cache, substring or
 * AND-of-words match across all columns.
 *
 * Source CSVs:
 *   data/chemical-inventory/brevitest.csv   (149 rows, C-001..C-149)
 *   data/chemical-inventory/fannin.csv      (55 rows, D-001..D-055)
 *
 * Both files share the same header schema. The owning-org label is derived
 * from the bundled filename (brevitest → 'brevitest', fannin → 'fannin').
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';

function loadCsvsFromFs(): Record<string, string> {
	const root = nodePath.resolve(process.cwd(), 'data/chemical-inventory');
	const out: Record<string, string> = {};
	if (!nodeFs.existsSync(root)) return out;
	for (const entry of nodeFs.readdirSync(root, { withFileTypes: true })) {
		if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
			out['/data/chemical-inventory/' + entry.name] = nodeFs.readFileSync(
				nodePath.join(root, entry.name),
				'utf8'
			);
		}
	}
	return out;
}

const CSV_FILES: Record<string, string> =
	typeof (import.meta as unknown as { glob?: unknown }).glob === 'function'
		? (import.meta.glob('/data/chemical-inventory/*.csv', {
				query: '?raw',
				import: 'default',
				eager: true
		  }) as Record<string, string>)
		: loadCsvsFromFs();

export type ChemicalOrg = 'brevitest' | 'fannin';

export interface ChemicalRow {
	org: ChemicalOrg;
	tag: string; // 'C-042' or 'D-018'
	name: string;
	cas: string;
	hazardClass: string;
	physicalState: string;
	quantityOnHand: string;
	primaryChemicalName: string;
	storageCode: string;
	inventoryLink: string | null;
	fields: Record<string, string>; // every non-empty header→value pair
}

export interface ChemicalLookupResult {
	matches: ChemicalRow[];
	totalReturned: number;
	truncated: boolean;
	totalAvailable: number;
	matchedOrgs: ChemicalOrg[]; // set when results come from multiple orgs
	dualStocked: string[]; // primary chemical names that appear in BOTH orgs in this result
	corpusFiles: string[];
	queryNormalized: string;
	timedOut: boolean;
}

const TIMEOUT_MS = 500;
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;
const MIN_QUERY_LEN = 2;

// Curated list — kept inline because the source-of-truth is the memory entry
// project_chemical_inventory_fannin.md and we don't want a runtime dep on
// that. Matched case-insensitively against both `Item` and
// `Primary Chemical Name` columns.
const DUAL_STOCKED_NAME_PATTERNS: RegExp[] = [
	/\bdmso\b/i,
	/\bipa\b|isopropyl alcohol|isopropanol/i,
	/\bethanol\b|ethyl alcohol/i,
	/\bpbs\b|phosphate.buffered saline/i,
	/\bnaoh\b|sodium hydroxide/i,
	/\bbsa\b|bovine serum albumin/i,
	/\bglycerol\b/i,
	/\bagarose\b/i,
	/\bdtt\b|dithiothreitol/i,
	/\btcep\b/i,
	/\bnacl\b|sodium chloride/i,
	/\bsucrose\b/i
];

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
	if (lines.length === 0) return { headers: [], rows: [], rowCount: 0 };
	const headers = parseCsvLine(lines[0]).map((h) => h.trim());
	const rows: string[][] = [];
	for (let i = 1; i < lines.length; i++) {
		const raw = lines[i];
		if (!raw || !raw.trim()) continue;
		const cells = parseCsvLine(raw);
		if (!cells[0]?.trim()) continue;
		rows.push(cells);
	}
	return { headers, rows, rowCount: rows.length };
}

interface CachedFile {
	org: ChemicalOrg;
	parsed: ParsedCsv;
}

let _cache: CachedFile[] | null = null;

function loadCorpus(): CachedFile[] {
	if (_cache) return _cache;
	const out: CachedFile[] = [];
	for (const [path, content] of Object.entries(CSV_FILES)) {
		const filename = path.split('/').pop() ?? path;
		const base = filename.replace(/\.csv$/i, '').toLowerCase();
		const org: ChemicalOrg = base.startsWith('fannin') ? 'fannin' : 'brevitest';
		out.push({ org, parsed: parseCsv(content) });
	}
	_cache = out;
	return out;
}

function rowToChemical(org: ChemicalOrg, headers: string[], cells: string[]): ChemicalRow {
	const fields: Record<string, string> = {};
	for (let i = 0; i < headers.length; i++) {
		const key = headers[i];
		if (!key) continue;
		const val = (cells[i] ?? '').trim();
		if (val) fields[key] = val;
	}
	return {
		org,
		tag: fields['Inventory Code'] ?? '',
		name: fields['Item'] ?? '',
		cas: fields['CAS #'] ?? '',
		hazardClass: fields['IFC Hazard Class'] ?? '',
		physicalState: fields['Physical State'] ?? '',
		quantityOnHand: fields['Current On Hand'] ?? '',
		primaryChemicalName: fields['Primary Chemical Name'] ?? '',
		storageCode: fields['Storage Code'] ?? '',
		inventoryLink: fields['Inventory Link'] || null,
		fields
	};
}

export interface ChemicalLookupOpts {
	hazardClass?: string;
	org?: ChemicalOrg | 'all';
	limit?: number;
}

export function lookupChemical(query: string, opts: ChemicalLookupOpts = {}): ChemicalLookupResult {
	const q = (query ?? '').trim();
	const limit = Math.min(Math.max(Number(opts.limit ?? DEFAULT_LIMIT), 1), MAX_LIMIT);
	const orgFilter = (opts.org && opts.org !== 'all') ? opts.org : null;
	const hazardFilter = (opts.hazardClass ?? '').trim().toLowerCase();

	const corpus = loadCorpus();
	const corpusFiles = corpus.map((c) => c.org);
	const result: ChemicalLookupResult = {
		matches: [],
		totalReturned: 0,
		truncated: false,
		totalAvailable: 0,
		matchedOrgs: [],
		dualStocked: [],
		corpusFiles,
		queryNormalized: q.toLowerCase(),
		timedOut: false
	};
	if (q.length < MIN_QUERY_LEN) return result;

	const startedAt = Date.now();
	const lower = q.toLowerCase();

	// Match strategy: substring on the full row OR AND-of-words across the row.
	const words = lower.split(/\s+/).filter((w) => w.length >= 2);

	const collected: ChemicalRow[] = [];
	let totalMatches = 0;
	const matchedOrgs = new Set<ChemicalOrg>();

	for (const file of corpus) {
		if (Date.now() - startedAt > TIMEOUT_MS) {
			result.timedOut = true;
			break;
		}
		if (orgFilter && file.org !== orgFilter) continue;

		for (const cells of file.parsed.rows) {
			const concatLower = cells.map((c) => (c ?? '').toLowerCase()).join(' | ');
			let matched = concatLower.includes(lower);
			if (!matched && words.length > 1) {
				matched = words.every((w) => concatLower.includes(w));
			}
			if (!matched) continue;

			if (hazardFilter) {
				const hazardCell = (cells[4] ?? '').toLowerCase();
				if (!hazardCell.includes(hazardFilter)) continue;
			}

			totalMatches++;
			matchedOrgs.add(file.org);
			if (collected.length < limit) {
				collected.push(rowToChemical(file.org, file.parsed.headers, cells));
			}
		}
	}

	// Detect dual-stocking: when results cover both orgs AND any returned row's
	// primary chemical name (or Item name) matches one of the dual-stocked
	// patterns, surface it for the operator.
	const dualStocked = new Set<string>();
	if (matchedOrgs.size > 1) {
		for (const row of collected) {
			const probe = `${row.name} ${row.primaryChemicalName}`.toLowerCase();
			for (const pat of DUAL_STOCKED_NAME_PATTERNS) {
				if (pat.test(probe)) {
					const label = row.primaryChemicalName || row.name;
					if (label) dualStocked.add(label);
				}
			}
		}
	}

	result.matches = collected;
	result.totalReturned = collected.length;
	result.totalAvailable = totalMatches;
	result.truncated = totalMatches > collected.length;
	result.matchedOrgs = Array.from(matchedOrgs);
	result.dualStocked = Array.from(dualStocked);
	return result;
}
