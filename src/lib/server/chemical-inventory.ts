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

/**
 * Storage-compatibility matrix — small set of well-known chemistry rules.
 * Used by chemical_hazard_summary to flag when two chemicals from a query
 * shouldn't share a shelf.
 *
 * Hazard codes match the IFC Hazard Class column in our CSVs:
 *   FLAM  flammable liquid/solid
 *   OX    oxidizer
 *   COR   corrosive (acid or base — we infer subtype from CAS / primary name)
 *   HTX   highly toxic (methotrexate, azides, organomercurials — full isolation)
 *   TOX   toxic
 *   WR    water-reactive (we infer from primary name when present)
 */
export interface IncompatibilityRule {
	when: (a: HazardProfile, b: HazardProfile) => boolean;
	reason: string;
}

interface HazardProfile {
	codes: string[];
	primaryNameLower: string;
	itemLower: string;
}

function profileFor(row: ChemicalRow): HazardProfile {
	const codes = (row.hazardClass ?? '')
		.split(/[;,\s]+/)
		.map((c) => c.trim().toUpperCase())
		.filter(Boolean);
	return {
		codes,
		primaryNameLower: (row.primaryChemicalName ?? '').toLowerCase(),
		itemLower: (row.name ?? '').toLowerCase()
	};
}

const IS_ACID = (p: HazardProfile): boolean =>
	p.codes.includes('COR') &&
	/(acid|hcl|hno3|h2so4|hydrochloric|sulfuric|nitric|phosphoric|acetic|formic|tcep|trifluoroacetic)/i.test(p.primaryNameLower + ' ' + p.itemLower);

const IS_BASE = (p: HazardProfile): boolean =>
	p.codes.includes('COR') &&
	/(naoh|koh|hydroxide|ammonia|amine|sodium hydroxide|potassium hydroxide|imidazole|tris|ethanolamine|tetraborate)/i.test(p.primaryNameLower + ' ' + p.itemLower);

const IS_WATER_REACTIVE = (p: HazardProfile): boolean =>
	/(metal sodium|metal potassium|lithium aluminum|aluminum chloride|magnesium powder|calcium hydride|water-reactive|reacts with water)/i.test(p.primaryNameLower + ' ' + p.itemLower);

const IS_AZIDE = (p: HazardProfile): boolean =>
	/azide/i.test(p.primaryNameLower + ' ' + p.itemLower);

const IS_CYTOTOXIC = (p: HazardProfile): boolean =>
	p.codes.includes('HTX') ||
	/(methotrexate|cytotoxic|antineoplastic|thimerosal|organomercury)/i.test(p.primaryNameLower + ' ' + p.itemLower);

export const INCOMPATIBILITY_RULES: IncompatibilityRule[] = [
	{
		when: (a, b) => a.codes.includes('FLAM') && b.codes.includes('OX'),
		reason: 'Flammable + oxidizer: fire risk on contact. Store on separate shelves with secondary containment.'
	},
	{
		when: (a, b) => a.codes.includes('OX') && /organic|alcohol|ipa|methanol|ethanol|glycerol|dmso|toluene|acetone|hexane/i.test(b.primaryNameLower + ' ' + b.itemLower),
		reason: 'Oxidizer + organic: spontaneous ignition risk. Keep oxidizers away from any organic solvent or fuel.'
	},
	{
		when: (a, b) => IS_ACID(a) && IS_BASE(b),
		reason: 'Acid + base: violent neutralization, heat release, splash risk. Store in separate corrosive cabinets.'
	},
	{
		when: (a, b) => IS_WATER_REACTIVE(a) && /(water|aqueous|buffer|saline|pbs)/i.test(b.primaryNameLower + ' ' + b.itemLower),
		reason: 'Water-reactive + aqueous source: violent reaction with humidity or splash. Keep in desiccated isolation.'
	},
	{
		when: (a, b) => IS_CYTOTOXIC(a),
		reason: 'Highly toxic (HTX) chemicals like methotrexate and organomercurials get full isolation — separate cabinet, separate spill kit, no co-storage with general inventory.'
	},
	{
		when: (a, b) => IS_AZIDE(a),
		reason: 'Sodium azide isolates entirely — never near acids (forms hydrazoic acid, explosive) or heavy-metal plumbing (forms shock-sensitive azides).'
	},
	{
		when: (a, b) => a.codes.includes('FLAM') && b.codes.includes('COR') && IS_ACID(b),
		reason: 'Flammable + concentrated acid: acids can ignite or accelerate decomposition. Use separate flammables cabinet.'
	}
];

export interface CompatibilityCheck {
	compatible: boolean;
	pairwise: Array<{ a: string; b: string; reason: string }>;
}

export function checkCompatibility(rows: ChemicalRow[]): CompatibilityCheck {
	const profiles = rows.map((r) => ({ row: r, profile: profileFor(r) }));
	const pairwise: Array<{ a: string; b: string; reason: string }> = [];
	for (let i = 0; i < profiles.length; i++) {
		for (let j = 0; j < profiles.length; j++) {
			if (i === j) continue;
			const a = profiles[i];
			const b = profiles[j];
			for (const rule of INCOMPATIBILITY_RULES) {
				if (rule.when(a.profile, b.profile)) {
					const label = (x: { row: ChemicalRow }) =>
						`${x.row.tag}${x.row.name ? ` (${x.row.name})` : ''}`;
					const entry = { a: label(a), b: label(b), reason: rule.reason };
					// De-dup: don't add (a,b) if we already have (b,a) with same reason.
					if (!pairwise.some((p) => p.a === entry.b && p.b === entry.a && p.reason === entry.reason)) {
						pairwise.push(entry);
					}
					break;
				}
			}
		}
	}
	return { compatible: pairwise.length === 0, pairwise };
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
