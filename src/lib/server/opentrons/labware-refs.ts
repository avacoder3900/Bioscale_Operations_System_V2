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
