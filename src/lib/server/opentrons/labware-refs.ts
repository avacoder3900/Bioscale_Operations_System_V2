/**
 * Which labware definitions does a protocol actually load?
 *
 * Used to narrow the upload bundle. BIMS historically shipped the entire labware
 * library with every protocol upload; that is wasteful, and unsafe once two
 * definitions share a loadName, because they collide on multipart filename and
 * the robot keeps an arbitrary one.
 *
 * Comments are stripped first. Retired decks linger in these protocols as
 * commented-out `load_labware` lines (decks 005/006), and re-bundling a retired
 * deck is precisely what this is meant to prevent.
 */

/** Remove Python `#` comments without touching a `#` inside a string literal. */
function stripComments(source: string): string {
	return source
		.split(/\r?\n/)
		.map((line) => {
			let quote: string | null = null;
			for (let i = 0; i < line.length; i++) {
				const ch = line[i];
				if (quote) {
					if (ch === quote && line[i - 1] !== '\\') quote = null;
				} else if (ch === '"' || ch === "'") {
					quote = ch;
				} else if (ch === '#') {
					return line.slice(0, i);
				}
			}
			return line;
		})
		.join('\n');
}

const PATTERNS: RegExp[] = [
	// protocol.load_labware('name', 10)
	/load_labware(?:_from_definition)?\s*\(\s*['"]([a-z0-9._]+)['"]/gi,
	// protocol.load_labware(load_name='name', location=10)
	/load_labware(?:_from_definition)?\s*\(\s*load_name\s*=\s*['"]([a-z0-9._]+)['"]/gi,
	// protocol.load_adapter('name', 10)
	/load_adapter\s*\(\s*['"]([a-z0-9._]+)['"]/gi
];

/**
 * The same calls with a NAME instead of a literal — resolved through the
 * module-level string constants of the file (2026-10-29). The arm's p300
 * rehearsal loads its rack as `load_labware(REHEARSAL_TIPRACK, 11)` with
 * `REHEARSAL_TIPRACK = '...200ul_tiprack'` at the top; the literal-only
 * patterns above missed it, the 200 µL rack was left out of the upload bundle,
 * and the robot's analysis failed on the unknown labware — which the run-start
 * freshness gate then reported as "analysis completed with errors".
 */
const IDENT_PATTERNS: RegExp[] = [
	/load_labware(?:_from_definition)?\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/g,
	/load_labware(?:_from_definition)?\s*\(\s*load_name\s*=\s*([A-Za-z_][A-Za-z0-9_]*)\s*[,)]/g,
	/load_adapter\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,/g
];

/** `NAME = 'literal'` / `NAME: str = "literal"` at column 0 → the literal. */
function stringConstants(code: string): Map<string, string> {
	const out = new Map<string, string>();
	const re = /^([A-Za-z_][A-Za-z0-9_]*)\s*(?::\s*str\s*)?=\s*['"]([a-z0-9._]+)['"]\s*$/gim;
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) out.set(m[1], m[2]);
	return out;
}

/**
 * Every labware loadName referenced by live (non-commented) protocol code.
 * Returns an empty array when nothing parses — callers should treat that as
 * "unknown", not as "no labware needed".
 */
export function labwareNamesReferencedBy(source: string): string[] {
	const code = stripComments(source ?? '');
	const names = new Set<string>();
	for (const pattern of PATTERNS) {
		const re = new RegExp(pattern.source, pattern.flags);
		let m: RegExpExecArray | null;
		while ((m = re.exec(code)) !== null) names.add(m[1]);
	}
	const constants = stringConstants(code);
	for (const pattern of IDENT_PATTERNS) {
		const re = new RegExp(pattern.source, pattern.flags);
		let m: RegExpExecArray | null;
		while ((m = re.exec(code)) !== null) {
			const literal = constants.get(m[1]);
			if (literal) names.add(literal);
		}
	}
	return [...names];
}

/**
 * The Particle-device-id → deck-loadName map a fill protocol carries.
 *
 * The robot picks which cartridge deck to load from a Particle id it reads over
 * USB serial, e.g.
 *   'e00fce68981a5e0784a62b71': protocol.load_labware('gen4deck_gen7cartridge_001', OFF_DECK)
 * Extracting it lets BIMS bind each deck Equipment row to the definition the
 * robot will actually load, instead of trusting convention.
 */
export function deckParticleMap(source: string): Record<string, string> {
	const code = stripComments(source ?? '');
	const re =
		/['"]([0-9a-f]{24})['"]\s*:\s*[\w.]*load_labware\s*\(\s*['"]([a-z0-9._]+)['"]/gi;
	const out: Record<string, string> = {};
	let m: RegExpExecArray | null;
	while ((m = re.exec(code)) !== null) out[m[1]] = m[2];
	return out;
}
