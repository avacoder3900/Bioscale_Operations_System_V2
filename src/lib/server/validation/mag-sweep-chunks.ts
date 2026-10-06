/**
 * Transport layer for device-uploaded magnetometer sweeps.
 *
 * The SPU cannot publish a whole sweep in one Particle event (classic events
 * cap at ~1 KB of data), so firmware v98 slices the sweep file and publishes
 * the slices about one per second. This module turns those publishes back into
 * rows: it decodes the per-chunk envelope, and decodes the reassembled payload.
 *
 * It deliberately accepts more shapes than the firmware will actually send.
 * The device half is being written in parallel with this one, and a webhook
 * that rejects a sweep over an envelope-key spelling loses a run that took ten
 * minutes of stage time to produce.
 */

import {
	RAW_FIELDS,
	ROW_FIELDS,
	ROW_FIELDS_WITH_SD,
	SD_OFFSET_BY_CHANNEL,
	MAX_ROWS,
	type SweepEnd
} from './mag-sweep.js';

/** Hard ceilings. A sweep is ~980 rows; these exist to bound abuse, not use. */
export const MAX_CHUNKS = 2000;
export const MAX_CHUNK_BYTES = 8192;
export const MAX_ASSEMBLED_BYTES = 4_000_000;

/**
 * The locked column order for per-position MEAN rows — 17 columns, one row per
 * (stage position, well), no rep column. Per channel CH: t{CH} is the mean
 * temperature, x/y/z{CH} the mean component over the reps at that position,
 * and sd{CH} the standard deviation of |B| over those reps.
 *
 * y / well / t{CH} / x{CH} / y{CH} / z{CH} are spelled exactly as in the
 * bench-side raw format on purpose: a consumer resolving columns by name works
 * on both formats with no extra code, and simply never finds sd{CH} in a raw
 * upload.
 *
 * This is the SPEC, not the source of truth for a given sweep. What gets stored
 * is whatever the device declared; this constant is only the fallback for an
 * undeclared payload, and the yardstick a mismatch is reported against.
 */
export const MEAN_FIELDS = [
	'y', 'well',
	'tA', 'xA', 'yA', 'zA', 'sdA',
	'tB', 'xB', 'yB', 'zB', 'sdB',
	'tC', 'xC', 'yC', 'zC', 'sdC'
];

export type ChunkEnvelope = { sweepId: string; index: number; total: number; slice: string };

const pick = (obj: Record<string, unknown>, keys: string[]): unknown => {
	for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) return obj[k];
	return undefined;
};

/**
 * Decode one publish into {sweepId, index, total, slice}.
 *
 * Preferred compact form, split on the first three pipes only so the payload
 * slice may contain anything at all:
 *     <sweepId>|<index>|<total>|<slice>
 * A JSON envelope {"id","i","n","d"} (and common key aliases) also works.
 *
 * Throws Error with an operator-readable message; the caller turns that into a
 * 400 rather than letting it reach the enum validator as a mystery 500.
 */
export function parseChunkEnvelope(raw: unknown): ChunkEnvelope {
	let sweepId: unknown, index: unknown, total: unknown, slice: unknown;

	const fromObject = (o: Record<string, unknown>) => {
		sweepId = pick(o, ['id', 'sweepId', 'sweep_id', 'sweep', 'sid']);
		index = pick(o, ['i', 'idx', 'index', 'seq', 'chunkIndex', 'chunk_index']);
		total = pick(o, ['n', 'total', 'count', 'chunks', 'totalChunks', 'total_chunks']);
		slice = pick(o, ['d', 'data', 'payload', 'chunk', 'slice', 'body']);
	};

	if (typeof raw === 'string') {
		let parsed: unknown = undefined;
		if (raw.trimStart().startsWith('{')) {
			try {
				parsed = JSON.parse(raw);
			} catch {
				parsed = undefined;
			}
		}
		if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
			fromObject(parsed as Record<string, unknown>);
		} else {
			// slice() rather than split() so no whitespace at either end of the
			// payload is lost — chunk boundaries fall mid-line, and a trimmed
			// slice silently corrupts the line it was cut from.
			const p1 = raw.indexOf('|');
			const p2 = p1 < 0 ? -1 : raw.indexOf('|', p1 + 1);
			const p3 = p2 < 0 ? -1 : raw.indexOf('|', p2 + 1);
			if (p3 < 0) {
				throw new Error('chunk must be "<sweepId>|<index>|<total>|<payload>" or a JSON envelope');
			}
			sweepId = raw.slice(0, p1);
			index = raw.slice(p1 + 1, p2);
			total = raw.slice(p2 + 1, p3);
			slice = raw.slice(p3 + 1);
		}
	} else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
		fromObject(raw as Record<string, unknown>);
	} else {
		throw new Error('chunk data must be a string or an object');
	}

	const id = String(sweepId ?? '').trim();
	if (!id) throw new Error('chunk is missing a sweep id');
	if (id.length > 128) throw new Error('sweep id exceeds 128 characters');

	const i = Number(index);
	const n = Number(total);
	if (!Number.isInteger(n) || n < 1) throw new Error(`totalChunks must be a positive integer, got ${String(total)}`);
	if (n > MAX_CHUNKS) throw new Error(`totalChunks ${n} exceeds the ${MAX_CHUNKS} chunk limit`);
	if (!Number.isInteger(i) || i < 0) throw new Error(`chunkIndex must be a non-negative integer, got ${String(index)}`);
	if (i >= n) throw new Error(`chunkIndex ${i} is out of range for totalChunks ${n}`);

	if (typeof slice !== 'string') throw new Error('chunk payload must be a string');
	if (slice.length > MAX_CHUNK_BYTES) throw new Error(`chunk payload exceeds ${MAX_CHUNK_BYTES} characters`);

	return { sweepId: id, index: i, total: n, slice };
}

/**
 * Join buffered slices in index order. Returns null when any index in
 * [0, total) is absent — a gap is reported, never quietly closed up, because
 * a sweep missing its middle still looks like a plausible sweep.
 */
export function assembleChunks(
	chunks: Record<string, string> | null | undefined,
	total: number
): { text: string | null; missing: number[] } {
	const have = chunks ?? {};
	const missing: number[] = [];
	const parts: string[] = [];

	for (let i = 0; i < total; i++) {
		const part = have[String(i)];
		if (typeof part !== 'string') {
			missing.push(i);
			continue;
		}
		parts.push(part);
	}

	if (missing.length > 0) return { text: null, missing };
	return { text: parts.join(''), missing };
}

/** Canonical name for a declared column: case and punctuation are not signal. */
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

type ColumnMap = {
	y: number;
	well: number;
	rep: number | null;
	channels: Record<string, { x: number; y: number; z: number; t: number | null; sd: number | null }>;
};

/**
 * Map declared column names onto the positions the analysis needs.
 *
 * Mapping by NAME rather than by offset is the whole point: the firmware is
 * still deciding whether its standard deviation is one column per channel or
 * one per axis, and either choice is fine as long as the header declares it.
 */
export function mapColumns(fields: string[]): ColumnMap {
	const map: ColumnMap = { y: -1, well: -1, rep: null, channels: {} };
	const chan = (ch: string) => (map.channels[ch] ??= { x: -1, y: -1, z: -1, t: null, sd: null });

	fields.forEach((raw, i) => {
		const n = norm(raw);
		if (!n) return;

		// Standard deviations must be matched before the mean patterns —
		// otherwise "sdxa" would fall through and be claimed as channel A's x
		// mean. They take no part in the peak/FWHM profile, but they are the
		// only noise estimate a means upload carries, so they are captured
		// rather than skipped.
		const sdLead = /^sd([xyz])?([abc])$/.exec(n);
		const sdTrail = sdLead ? null : /^([abc])sd([xyz])?$/.exec(n);
		if (sdLead || sdTrail) {
			const axis = sdLead ? sdLead[1] : sdTrail![2];
			const ch = (sdLead ? sdLead[2] : sdTrail![1]).toUpperCase();
			// A per-axis SD (sdxA/sdyA/sdzA) is not a spread of |B|, so there is
			// no single noise figure to carry forward from it. It stays in
			// rawData.rows, which is verbatim, and is not summarised.
			if (!axis) chan(ch).sd ??= i;
			return;
		}

		if (n === 'y' || n === 'ymicrons' || n === 'yum' || n === 'pos' || n === 'position') { map.y = i; return; }
		if (n === 'well' || n === 'w') { map.well = i; return; }
		if (n === 'rep' || n === 'reps' || n === 'n' || n === 'samples' || n === 'count' || n === 'nsamples') {
			map.rep = i; return;
		}

		let m = /^t([abc])$/.exec(n) ?? /^([abc])t$/.exec(n);
		if (m) { chan(m[1].toUpperCase()).t = i; return; }

		m = /^(?:mean)?([xyz])([abc])$/.exec(n);
		if (m) { chan(m[2].toUpperCase())[m[1] as 'x' | 'y' | 'z'] = i; return; }

		m = /^([abc])(?:mean)?([xyz])$/.exec(n);
		if (m) { chan(m[1].toUpperCase())[m[2] as 'x' | 'y' | 'z'] = i; return; }
	});

	return map;
}

/**
 * Project declared rows into the canonical raw layout the analysis consumes:
 * [y, well, rep, (t,x,y,z) x A,B,C], optionally followed by [sdA, sdB, sdC]
 * when the device sent per-channel spreads.
 *
 * The three SD columns are appended only when at least one exists, so a raw
 * upload projects to exactly the 15 columns the bench-side path produces and
 * lands as the identical document.
 *
 * A channel the device did not send stays NaN rather than 0 — aggregate()
 * skips non-finite components, so an absent channel disappears from the
 * results instead of being reported as a magnetometer reading zero field.
 */
const CHANNEL_ORDER = ['A', 'B', 'C'];

/**
 * Undo the fixed-point transport encoding.
 *
 * The device emits no floating-point text anywhere, so every CHANNEL value in
 * an uploaded row is an integer scaled by the `scale=` token in the header.
 * Position and well are NOT scaled — descaling them would move every stage
 * position by two orders of magnitude while leaving rows that still parse.
 *
 * The divisor is read from the payload, never assumed: a receiver that silently
 * hardcoded the current 100 would keep working right up until the day it did
 * not, and the failure would look like plausible data rather than an error.
 */
export function descaleRows(rows: number[][], map: ColumnMap, scale: number): number[][] {
	if (!(scale > 0) || scale === 1) return rows.map((r) => r.slice());

	const valueCols = new Set<number>();
	for (const ch of CHANNEL_ORDER) {
		const c = map.channels[ch];
		if (!c) continue;
		for (const i of [c.t, c.x, c.y, c.z, c.sd]) if (i != null && i >= 0) valueCols.add(i);
	}

	return rows.map((r) => r.map((v, i) => (valueCols.has(i) ? v / scale : v)));
}

/**
 * True when a channel's values are placeholders rather than measurements.
 *
 * DO NOT simplify this to `sd < 0`. The locked 17-column list has no room for a
 * sample count, so the firmware overloads sd to mean "not a pooled measurement"
 * — but that covers two genuinely different states:
 *
 *   n == 0  nothing was read: `if (n > 0)` never runs, so t/x/y/z stay zero and
 *           the row is a true placeholder.
 *   n == 1  one reading was taken: `mean[field] = sum / n` DOES run, so t/x/y/z
 *           hold a real unaveraged measurement; only the n > 1 spread block is
 *           skipped, leaving sd at the sentinel.
 *
 * Skipping on sd alone would discard that real measurement, and would do it
 * exactly on a well where seven of eight reads failed — the degraded well an
 * operator most needs to see. So the discriminator is the zero test: t is a
 * temperature reading roughly 20-45 C on this hardware, so an exactly-zero t
 * alongside exactly-zero x/y/z does not occur for a real reading.
 *
 * An n == 1 channel is therefore kept as a measurement with UNKNOWN noise: its
 * values stay in the analysis, and projectRows() leaves its sd NaN so it is
 * absent from the noise block rather than reported as a perfect zero spread.
 *
 * (team-lead specified the blunt `sd < 0` rule, then withdrew it on this
 * evidence. Firmware v98 is finalised, so a -2 sentinel or a sample-count
 * column is deliberately not being requested — this test gets the same result
 * with no wire-format change.)
 */
function isPlaceholder(r: number[], c: { x: number; y: number; z: number; t: number | null; sd: number | null }) {
	if (c.sd == null || !(Number(r[c.sd]) < 0)) return false;
	const comps = [r[c.x], r[c.y], r[c.z]];
	if (c.t != null) comps.push(r[c.t]);
	return comps.every((v) => Number(v) === 0);
}

/**
 * Project declared rows into the canonical raw layout the analysis consumes:
 * [y, well, rep, (t,x,y,z) x A,B,C], optionally followed by [sdA, sdB, sdC]
 * when the device sent per-channel spreads.
 *
 * The three SD columns are appended only when at least one exists, so a raw
 * upload projects to exactly the 15 columns the bench-side path produces and
 * lands as the identical document.
 *
 * Absent data becomes NaN, never 0 — aggregate() skips non-finite components,
 * so a channel the device omitted, a well that read nothing, and a spread that
 * was not computable all disappear from the results instead of being reported
 * as measurements of zero.
 *
 * Rows expect values that are already descaled.
 */
export function projectRows(rows: number[][], map: ColumnMap): { rows: number[][]; placeholders: number } {
	const anySd = CHANNEL_ORDER.some((ch) => map.channels[ch]?.sd != null);
	const width = anySd ? ROW_FIELDS_WITH_SD : ROW_FIELDS;
	const out: number[][] = [];
	let placeholders = 0;

	for (const r of rows) {
		const row = new Array<number>(width).fill(NaN);
		row[0] = Number(r[map.y]);
		row[1] = Number(r[map.well]);
		row[2] = map.rep !== null ? Number(r[map.rep]) : 1;

		let live = 0;
		CHANNEL_ORDER.forEach((ch, ci) => {
			const c = map.channels[ch];
			const base = 3 + ci * 4;
			if (!c || c.x < 0 || c.y < 0 || c.z < 0) return;
			if (isPlaceholder(r, c)) return; // leaves the whole channel NaN

			live++;
			row[base] = c.t !== null ? Number(r[c.t]) : 0;
			row[base + 1] = Number(r[c.x]);
			row[base + 2] = Number(r[c.y]);
			row[base + 3] = Number(r[c.z]);

			// Only a non-negative spread is a real one. A surviving sentinel here
			// is the n == 1 case: a genuine reading whose noise is unknown, so
			// the slot stays NaN and the channel simply has no noise figure.
			// Never 0 — that would report an invented perfect repeatability.
			const sd = c.sd != null ? Number(r[c.sd]) : NaN;
			if (anySd && Number.isFinite(sd) && sd >= 0) row[SD_OFFSET_BY_CHANNEL[ch]] = sd;
		});

		// Every channel read nothing here. The row stays in rawData.rows (the
		// device emits points x wells rows so a receiver can check completeness
		// by counting) but contributes no reading. The sample count is per well,
		// not per channel, so in practice channels agree.
		if (live === 0) {
			placeholders++;
			continue;
		}
		out.push(row);
	}
	return { rows: out, placeholders };
}

export type DecodedSweep = {
	format: string;
	meta: Record<string, unknown> | null;
	end: SweepEnd;
	fields: string[];
	/**
	 * The device's rows with the fixed-point transport encoding undone — real
	 * values, in the device's own raw units, in the declared column order. This
	 * is what gets stored; meta.scale records the divisor that was applied.
	 */
	rows: number[][];
	/** The `scale=` divisor taken from the payload header; 1 when unscaled. */
	scale: number;
	/** Rows where every channel was the device's "read nothing here" placeholder. */
	placeholderRows: number;
	/** The same rows projected to the 15-column raw layout — what gets analysed. */
	analysisRows: number[][];
	errors: string[];
	/** An SPU identifier the device put in its header, if any. */
	spuToken: string | null;
	/** False when the payload carried no fields= header and the spec was assumed. */
	fieldsDeclared: boolean;
	/**
	 * Set when the device declared a column list that differs from the locked
	 * spec for its format. The declared list is still what gets stored — a
	 * format drift has to be visible, not smoothed over.
	 */
	fieldSpecMismatch: { expected: string[]; actual: string[] } | null;
};

const KV_NUMERIC = /^-?\d+(\.\d+)?$/;

function parseTokens(tokens: string[]): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	for (const tok of tokens) {
		const eq = tok.indexOf('=');
		if (eq <= 0) continue;
		const k = tok.slice(0, eq).trim();
		const v = tok.slice(eq + 1).trim();
		out[k] = KV_NUMERIC.test(v) ? Number(v) : v;
	}
	return out;
}

/**
 * Decode a reassembled sweep payload.
 *
 * Accepts the tab-separated text the device already knows how to produce
 * (SWPBEGIN header / data rows / SWPEND footer), or a single JSON document.
 * Data rows tagged "S" are per-rep raw rows, identical to what the bench-side
 * pusher sends; rows tagged "M" are per-position means.
 */
export function decodeSweepPayload(text: string): DecodedSweep {
	const trimmed = text.trimStart();

	if (trimmed.startsWith('{')) return decodeJsonPayload(trimmed);
	return decodeTextPayload(text);
}

function finish(
	fields: string[],
	rows: number[][],
	meta: Record<string, unknown> | null,
	end: SweepEnd,
	errors: string[],
	spuToken: string | null,
	fieldsDeclared: boolean
): DecodedSweep {
	if (rows.length === 0) throw new Error('payload contained no data rows');
	if (rows.length > MAX_ROWS) throw new Error(`payload has ${rows.length} rows, exceeding the ${MAX_ROWS} limit`);

	const map = mapColumns(fields);
	if (map.y < 0) throw new Error(`no stage-position column in fields [${fields.join(', ')}]`);
	if (map.well < 0) throw new Error(`no well column in fields [${fields.join(', ')}]`);

	const usable = Object.entries(map.channels).filter(([, c]) => c.x >= 0 && c.y >= 0 && c.z >= 0);
	if (usable.length === 0) {
		throw new Error(`no channel had all of x, y and z in fields [${fields.join(', ')}]`);
	}

	// Identical field list to the bench-side pusher means identical rows, so
	// the two ingest paths store the same format string for the same content.
	const sameAs = (spec: string[]) =>
		fields.length === spec.length && fields.every((f, i) => norm(f) === norm(spec[i]));

	const isRaw = sameAs(RAW_FIELDS);
	const spec = isRaw ? RAW_FIELDS : MEAN_FIELDS;

	// scale= is a transport encoding declared per upload. Absent means unscaled,
	// which is what the bench-side raw format has always been.
	const rawScale = meta?.scale;
	const scale = typeof rawScale === 'number' && rawScale > 0 ? rawScale : 1;
	if (rawScale !== undefined && scale === 1 && rawScale !== 1) {
		throw new Error(`header declared an unusable scale=${String(rawScale)}`);
	}

	// Stored rows are real values, not the wire's fixed-point integers; meta
	// retains scale= so the original integers stay recoverable.
	const descaled = descaleRows(rows, map, scale);
	const projected = projectRows(descaled, map);

	if (projected.rows.length === 0) {
		throw new Error(`all ${rows.length} rows were placeholders — no well returned a reading`);
	}

	return {
		format: isRaw ? 'spu-mag-sweep/v1' : 'spu-mag-sweep-means/v1',
		meta,
		end,
		fields,
		rows: descaled,
		analysisRows: projected.rows,
		scale,
		placeholderRows: projected.placeholders,
		errors,
		spuToken,
		fieldsDeclared,
		// Reported, never corrected. The stored fields[] stays exactly what the
		// device said its columns were.
		fieldSpecMismatch: sameAs(spec) ? null : { expected: [...spec], actual: [...fields] }
	};
}

function decodeJsonPayload(text: string): DecodedSweep {
	let doc: any;
	try {
		doc = JSON.parse(text);
	} catch (e) {
		throw new Error(`payload is not valid JSON: ${(e as Error).message}`);
	}

	const rawRows = Array.isArray(doc?.rows) ? doc.rows : null;
	if (!rawRows) throw new Error('JSON payload has no rows[]');

	const fieldsDeclared = Array.isArray(doc?.fields) && doc.fields.length > 0;
	const fields: string[] = fieldsDeclared
		? doc.fields.map(String)
		: rawRows[0]?.length === RAW_FIELDS.length
			? [...RAW_FIELDS]
			: [...MEAN_FIELDS];

	const rows: number[][] = [];
	for (const r of rawRows) {
		if (!Array.isArray(r) || r.length < fields.length) continue;
		rows.push(r.slice(0, fields.length).map(Number));
	}

	const meta = doc?.meta && typeof doc.meta === 'object' ? doc.meta : null;
	const spuToken = doc?.spu ?? doc?.udi ?? meta?.spu ?? meta?.udi ?? null;

	return finish(fields, rows, meta, doc?.end ?? null, [], spuToken ? String(spuToken) : null, fieldsDeclared);
}

function decodeTextPayload(text: string): DecodedSweep {
	let meta: Record<string, unknown> | null = null;
	let end: SweepEnd = null;
	let declared: string[] | null = null;
	let sawMeanTag = false;
	const errors: string[] = [];
	const rows: number[][] = [];

	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const tokens = line.split('\t');
		const tag = tokens[0].trim();

		if (tag === 'SWPBEGIN') {
			meta = parseTokens(tokens.slice(1));
			const f = meta.fields;
			if (typeof f === 'string' && f.length > 0) {
				declared = f.split(',').map((s) => s.trim()).filter(Boolean);
			}
			continue;
		}
		if (tag === 'SWPEND') {
			const kv = parseTokens(tokens.slice(1));
			end = { rows: kv.rows as number, good: kv.good as number, ms: kv.ms as number };
			continue;
		}
		if (tag === 'SWPERR') {
			errors.push(tokens.slice(1).join(' ').trim());
			continue;
		}
		if (tag !== 'S' && tag !== 'M') continue;

		if (tag === 'M') sawMeanTag = true;
		rows.push(tokens.slice(1).map((v) => Number(v.trim())));
	}

	// Column names come from the header when the device declares them; the tag
	// only decides the fallback. A truncated first chunk therefore costs the
	// declared names, not the run.
	const widest = rows.reduce((w, r) => Math.max(w, r.length), 0);
	const fallback = sawMeanTag || widest !== RAW_FIELDS.length ? MEAN_FIELDS : RAW_FIELDS;
	const fields = declared ?? [...fallback];

	const spuToken = meta?.spu ?? meta?.udi ?? meta?.spuUdi ?? null;

	// Rows narrower than the declared header lost fields in transit; dropping
	// them is the same call cleanRawRows() makes on the agent path.
	const kept = rows.filter((r) => r.length >= fields.length).map((r) => r.slice(0, fields.length));

	return finish(fields, kept, meta, end, errors, spuToken ? String(spuToken) : null, declared !== null);
}
