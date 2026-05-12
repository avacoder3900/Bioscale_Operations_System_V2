/**
 * Floor-plan / location resolver — answers "where is X?" by mapping equipment
 * tags and zone names to a spatial description of the new shared Houston lab.
 *
 * Zone shapes come from the captured floor-plan layout (memory entry
 * `project_floor_plan_layout`). Tag-to-zone mapping is derived at module load
 * from the same equipment CSVs the equipment-datasheet tool reads, using the
 * row's "Location" column.
 */
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import { lookupEquipment } from './equipment-datasheets';

// Same fs-fallback + Vite glob pattern as equipment-datasheets, so we can read
// EVERY row from the bundled CSVs (the public lookupEquipment caps at 10).
function loadEquipmentCsvsFromFs(): Record<string, string> {
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

const EQUIPMENT_CSV_FILES: Record<string, string> =
	typeof (import.meta as unknown as { glob?: unknown }).glob === 'function'
		? (import.meta.glob('/data/equipment-datasheets/*.csv', {
				query: '?raw',
				import: 'default',
				eager: true
		  }) as Record<string, string>)
		: loadEquipmentCsvsFromFs();

export type ZoneId =
	| 'tissue-culture'
	| 'open-lab'
	| 'manufacturing'
	| 'r-and-d'
	| 'prototyping'
	| 'inventory'
	| 'office';

export interface Zone {
	id: ZoneId;
	name: string;
	owningOrg: 'brevitest' | 'fannin' | 'shared';
	position: string; // human-readable spatial position on the floor plan
	description: string; // 1-2 sentence what's-in-here
	band: 'top' | 'middle' | 'bottom' | 'other';
}

export const ZONES: Record<ZoneId, Zone> = {
	'tissue-culture': {
		id: 'tissue-culture',
		name: 'Tissue Culture',
		owningOrg: 'fannin',
		position: 'top band, west side — enclosed room on the Fannin half of the lab',
		description: 'Houses the F-01 biosafety cabinet, F-06 fridge/freezer combo, a CO2 incubator, microscope, water filtration, and a -20 freezer. This is where Fannin works with human cells, blood, and biological samples.',
		band: 'top'
	},
	'open-lab': {
		id: 'open-lab',
		name: 'Open Lab',
		owningOrg: 'shared',
		position: 'top band, east of Tissue Culture; runs west-to-east along the north wall',
		description: 'Shared bench/fridge corridor along the north wall. Flammable cabinets, fridge/freezer combos, the -80, chest freezer, and a 48" fume hood live here. The Brevitest R&D side\'s 2x2 bench grid + B-Cab/B-28 cabinets frame the east wall.',
		band: 'top'
	},
	'manufacturing': {
		id: 'manufacturing',
		name: 'Manufacturing',
		owningOrg: 'brevitest',
		position: 'bottom band, west side',
		description: 'Brevitest manufacturing floor — B-04/B-05/B-09 work tables, the main OT-2 Opentrons row (E-36), Cartridge Sealer (E-37), in-process fridges (E-55/E-56), the Cartridge Oven (E-88), Deck Oven (E-87), Lyophilizer (E-29), Cell Oven (E-47), MFG Scale (E-49), presses, inspection stations, and the south-wall whiteboard (B-20).',
		band: 'bottom'
	},
	'r-and-d': {
		id: 'r-and-d',
		name: 'R&D',
		owningOrg: 'brevitest',
		position: 'bottom band, east side',
		description: 'Brevitest R&D bench area — B-21/B-22/B-23 benches with pH meter (E-61), hot plates (E-62/E-63), sonicator (E-64), bead bath (E-66), and pipette holders. Fridge/freezer bank (B-12/B-13/B-16/B-17) along the east wall. SPU shelving (B-03) is staged near B-22.',
		band: 'bottom'
	},
	'prototyping': {
		id: 'prototyping',
		name: 'Prototyping',
		owningOrg: 'brevitest',
		position: 'separate room — not visible on the main floor plan',
		description: 'Brevitest fabrication shop. Glowforge laser (E-75), Carbide3D Nomad CNC (E-76), Form Printer/Wash/Cure (E-77/E-78/E-79), Elegoo resin printer (E-80), Fume Extractor (E-50), Lenovo workstation (E-40), soldering bench (B-33/B-34/B-35).',
		band: 'other'
	},
	'inventory': {
		id: 'inventory',
		name: 'Inventory',
		owningOrg: 'brevitest',
		position: 'separate room — wire/cardboard shelving',
		description: 'Brevitest inventory storage room with B-30/B-31/B-32 shelving for parts, consumables, and packaging materials.',
		band: 'other'
	},
	'office': {
		id: 'office',
		name: 'Office / ROG',
		owningOrg: 'shared',
		position: 'office area',
		description: 'Office, file cabinets (E-91/E-92), and the ROG cage partition (E-90). Office storage at E-120.',
		band: 'other'
	}
};

// Normalization map — incoming raw Location values from the CSVs mapped to
// canonical zone IDs. Anything not listed here falls back to a fuzzy match
// against zone names.
const LOCATION_TO_ZONE: Record<string, ZoneId> = {
	'tissue culture': 'tissue-culture',
	'tissue culture lab': 'tissue-culture',
	'open lab': 'open-lab',
	'manufacturing': 'manufacturing',
	'r&d': 'r-and-d',
	'r & d': 'r-and-d',
	'rd': 'r-and-d',
	'prototyping': 'prototyping',
	'prototyping/fab': 'prototyping',
	'prototyping/fabrication': 'prototyping',
	'fabrication': 'prototyping',
	'inventory': 'inventory',
	'office': 'office',
	'office/rog': 'office',
	'rog': 'office'
};

function normalizeZoneId(raw: string): ZoneId | null {
	if (!raw) return null;
	const key = raw.toLowerCase().trim();
	if (LOCATION_TO_ZONE[key]) return LOCATION_TO_ZONE[key];
	// Fuzzy fallback — match zone name as substring.
	for (const zone of Object.values(ZONES)) {
		if (key.includes(zone.name.toLowerCase())) return zone.id;
	}
	return null;
}

interface TagToZoneEntry {
	zoneId: ZoneId;
	rawLocation: string;
	equipmentName: string;
	source: string; // 'BT' | 'Fannin'
}

let _tagMap: Map<string, TagToZoneEntry> | null = null;

function parseCsvLine(line: string): string[] {
	const out: string[] = [];
	let cur = '';
	let inQuotes = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (inQuotes) {
			if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
			else if (ch === '"') inQuotes = false;
			else cur += ch;
		} else if (ch === '"') inQuotes = true;
		else if (ch === ',') { out.push(cur); cur = ''; }
		else cur += ch;
	}
	out.push(cur);
	return out;
}

function buildTagMap(): Map<string, TagToZoneEntry> {
	if (_tagMap) return _tagMap;
	const map = new Map<string, TagToZoneEntry>();

	for (const [path, content] of Object.entries(EQUIPMENT_CSV_FILES)) {
		const filename = path.split('/').pop() ?? path;
		const source = filename.replace(/\.csv$/i, '');
		const lines = content.split(/\r?\n/);

		// Locate the header row (the one whose first cell is "Tag #").
		let headerIdx = -1;
		for (let i = 0; i < Math.min(8, lines.length); i++) {
			const cells = parseCsvLine(lines[i]);
			const first = (cells[0] ?? '').trim().toLowerCase();
			if (first === 'tag #' || first === 'tag#' || first === 'tag') {
				headerIdx = i;
				break;
			}
		}
		if (headerIdx === -1) continue;

		const headers = parseCsvLine(lines[headerIdx]).map((h) => h.trim());
		const tagIdx = headers.indexOf('Tag #');
		const equipmentIdx = headers.findIndex((h) => h === 'Equipment' || h === 'Equiment');
		// BT.csv has TWO columns named "Location" — the second one is the zone.
		// Walk the headers and pick the LAST occurrence as the zone.
		let locationIdx = -1;
		for (let i = headers.length - 1; i >= 0; i--) {
			if (headers[i].toLowerCase() === 'location') { locationIdx = i; break; }
		}
		if (tagIdx === -1 || locationIdx === -1) continue;

		for (let i = headerIdx + 1; i < lines.length; i++) {
			const raw = lines[i];
			if (!raw || !raw.trim()) continue;
			const cells = parseCsvLine(raw);
			const tag = (cells[tagIdx] ?? '').trim();
			if (!tag) continue;
			const rawLocation = (cells[locationIdx] ?? '').trim();
			const zoneId = normalizeZoneId(rawLocation);
			if (!zoneId) continue;
			map.set(tag.toUpperCase(), {
				zoneId,
				rawLocation,
				equipmentName: equipmentIdx >= 0 ? (cells[equipmentIdx] ?? '').trim() : '',
				source
			});
		}
	}

	_tagMap = map;
	return map;
}

export interface LocationResolveResult {
	matchedAs: 'tag' | 'zone' | 'equipment-name' | 'unresolved';
	zone: Zone | null;
	tagEntry: TagToZoneEntry | null; // when matchedAs === 'tag'
	equipmentInZone: Array<{ tag: string; equipmentName: string; rawLocation: string; source: string }>;
	notes: string[];
}

/**
 * Resolve a query string ("B-01", "Tissue Culture", "biosafety cabinet") to a
 * floor-plan location.
 */
export function resolveLocation(query: string): LocationResolveResult {
	const q = (query ?? '').trim();
	const result: LocationResolveResult = {
		matchedAs: 'unresolved',
		zone: null,
		tagEntry: null,
		equipmentInZone: [],
		notes: []
	};
	if (!q) {
		result.notes.push('Query was empty.');
		return result;
	}

	const tagMap = buildTagMap();

	// 1. Exact tag match (case-insensitive)?
	const upper = q.toUpperCase();
	if (tagMap.has(upper)) {
		const entry = tagMap.get(upper)!;
		result.matchedAs = 'tag';
		result.tagEntry = entry;
		result.zone = ZONES[entry.zoneId];
		// Include other equipment in the same zone for context (up to 12 items).
		result.equipmentInZone = listEquipmentInZone(entry.zoneId, 12, upper);
		return result;
	}

	// 2. Zone name match (e.g. "tissue culture", "manufacturing")?
	const zoneId = normalizeZoneId(q);
	if (zoneId) {
		result.matchedAs = 'zone';
		result.zone = ZONES[zoneId];
		result.equipmentInZone = listEquipmentInZone(zoneId, 25);
		return result;
	}

	// 3. Equipment-name fuzzy match — single hit means a direct answer.
	const equipResult = lookupEquipment(q);
	if (equipResult.matches.length > 0) {
		// Pick the first match that has a resolvable zone.
		for (const row of equipResult.matches) {
			const tagKey = row.tag.toUpperCase();
			const entry = tagMap.get(tagKey);
			if (entry) {
				result.matchedAs = 'equipment-name';
				result.tagEntry = entry;
				result.zone = ZONES[entry.zoneId];
				result.equipmentInZone = listEquipmentInZone(entry.zoneId, 12, tagKey);
				return result;
			}
		}
		result.notes.push(`Found ${equipResult.matches.length} equipment match(es) for "${q}" but none have a resolvable Location column. Check the equipment CSV.`);
	}

	result.notes.push(`Nothing matched "${q}". Try an equipment tag (B-NN, F-NN, E-NN), a zone name (Tissue Culture, Open Lab, Manufacturing, R&D, Prototyping), or an equipment name.`);
	return result;
}

function listEquipmentInZone(zoneId: ZoneId, limit: number, excludeTag?: string): Array<{ tag: string; equipmentName: string; rawLocation: string; source: string }> {
	const tagMap = buildTagMap();
	const out: Array<{ tag: string; equipmentName: string; rawLocation: string; source: string }> = [];
	for (const [tag, entry] of tagMap.entries()) {
		if (entry.zoneId !== zoneId) continue;
		if (excludeTag && tag === excludeTag) continue;
		out.push({
			tag,
			equipmentName: entry.equipmentName,
			rawLocation: entry.rawLocation,
			source: entry.source
		});
		if (out.length >= limit) break;
	}
	return out;
}

/**
 * Test/diagnostic — returns the full tag→zone map. Used by the harness fixture
 * and any future admin view.
 */
export function getTagMapSize(): number {
	return buildTagMap().size;
}
