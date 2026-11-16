/**
 * Which magnetometer took a reading.
 *
 * There are two physical magnetometers on the bench and nothing in a reading
 * says which one produced it. Their barcodes look like
 *   MAG-001-e00fce685d49ee5dc2a29545
 * and the FULL barcode is the identity: a 2023 unit was also labelled MAG-001
 * with a different hex suffix, so the short label alone is for display only.
 *
 * This file is pure (no database, no SvelteKit) so it can be unit-tested and
 * imported by scripts. The database half lives in magnetometer-identity-fill.ts.
 *
 * HOW A SENDER MAY SPELL IT (all optional, all tolerated):
 *   top-level body field   magnetometer | instrument | magBarcode
 *   header / meta key      mag | magnetometer | instrument | jig
 * A value may be the barcode string itself or an object carrying `barcode`.
 * A missing or malformed value NEVER fails an ingest — a sweep is 19 minutes of
 * stage time, so it is stored without the identity and filled in later.
 */

/** How we know which magnetometer it was. */
export const MAGNETOMETER_SOURCES = ['device', 'bench', 'device-log', 'manual', 'inferred'] as const;
export type MagnetometerSource = (typeof MAGNETOMETER_SOURCES)[number];

export interface MagnetometerId {
	/** Full barcode, canonical spelling: `MAG-001-<lowercase hex>`, or just `MAG-001` when the suffix is unknown. */
	barcode: string;
	/** Short display label, `MAG-001`. */
	label: string;
}

export interface MagnetometerRecord extends MagnetometerId {
	source: MagnetometerSource;
	recordedAt: Date;
	recordedBy: string | null;
	/** device-log only: when the device scanned the barcode, per its own clock. */
	scannedAt?: Date | null;
}

const BARCODE_RE = /^MAG-(\d{3})(?:-([0-9a-f]+))?$/i;
/** The same shape, findable inside a longer string (a log line). */
const BARCODE_IN_TEXT = /MAG-\d{3}(?:-[0-9a-f]+)?(?![0-9a-z-])/i;

/** Body fields and header keys a sender may use. Matched case-insensitively. */
export const BODY_KEYS = ['magnetometer', 'instrument', 'magBarcode'] as const;
export const META_KEYS = ['mag', 'magnetometer', 'instrument', 'jig'] as const;

/**
 * Canonicalise a magnetometer barcode. Returns null for anything that is not
 * `MAG-ddd` optionally followed by `-<hex>` — never throws, never guesses.
 */
export function normaliseMagnetometerBarcode(raw: unknown): MagnetometerId | null {
	if (raw && typeof raw === 'object') {
		const o = raw as Record<string, unknown>;
		return normaliseMagnetometerBarcode(o.barcode ?? o.id ?? o.label ?? null);
	}
	if (typeof raw !== 'string') return null;
	// Scanners and shells add whitespace, quotes and brackets; none of it is signal.
	const s = raw.trim().replace(/^[\s"'[(<]+|[\s"'\])>]+$/g, '');
	const m = BARCODE_RE.exec(s);
	if (!m) return null;
	const label = `MAG-${m[1]}`;
	return { barcode: m[2] ? `${label}-${m[2].toLowerCase()}` : label, label };
}

function lookup(obj: unknown, keys: readonly string[]): MagnetometerId | null {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
	const entries = Object.entries(obj as Record<string, unknown>);
	for (const key of keys) {
		const want = key.toLowerCase();
		for (const [k, v] of entries) {
			if (k.toLowerCase() !== want) continue;
			const id = normaliseMagnetometerBarcode(v);
			if (id) return id;
		}
	}
	return null;
}

/**
 * Find a magnetometer identity in whatever a sender provided.
 *
 * `where` says which place it was found in, because that decides the stored
 * source: a top-level body field is the bench pusher speaking, a header key is
 * the firmware's own SWPBEGIN line.
 */
export function pickMagnetometer(
	body: unknown,
	meta?: unknown
): (MagnetometerId & { where: 'body' | 'meta' }) | null {
	const fromBody = lookup(body, BODY_KEYS);
	if (fromBody) return { ...fromBody, where: 'body' };
	const fromMeta = lookup(meta, META_KEYS);
	if (fromMeta) return { ...fromMeta, where: 'meta' };
	return null;
}

/**
 * The magnetometer named in a five-point test payload (`magnet_validation`,
 * i.e. the file /validation/magnet-<epoch>.txt).
 *
 * Firmware v110 appends ONE trailing line after the five well rows:
 *     mag=MAG-001-e00fce685d49ee5dc2a29545
 * (file only; omitted when the device does not know).
 *
 * The device's 1024-byte buffer is not cleared between reads, so bytes of an
 * older, longer payload can follow the current file. Hence:
 *   - only a FULL line counts, with the full 24-hex barcode — a fragment of a
 *     stale line is ignored;
 *   - the FIRST such line wins, never the last — anything after it is stale;
 *   - it must directly follow a well row. When the current file has no mag=
 *     line, what follows its last row is the middle of some older payload, and
 *     a complete mag= line further down that debris belongs to a previous test.
 */
const MAG_PAYLOAD_LINE = /^mag=(MAG-\d{3}-[0-9a-f]{24})\s*$/i;
const WELL_ROW = /^[1-5]\t/;

export function extractMagnetometerFromMagPayload(raw: unknown): MagnetometerId | null {
	if (typeof raw !== 'string' || raw.length === 0) return null;
	let prev = '';
	for (const line of raw.split(/\r?\n/)) {
		if (line.trim().length === 0) continue;
		const m = MAG_PAYLOAD_LINE.exec(line);
		if (m) return WELL_ROW.test(prev) ? normaliseMagnetometerBarcode(m[1]) : null;
		prev = line;
	}
	return null;
}

export function buildMagnetometerRecord(
	id: MagnetometerId,
	source: MagnetometerSource,
	recordedBy: string | null,
	extra: { recordedAt?: Date; scannedAt?: Date | null } = {}
): MagnetometerRecord {
	return {
		barcode: id.barcode,
		label: id.label,
		source,
		recordedAt: extra.recordedAt ?? new Date(),
		recordedBy,
		...(extra.scannedAt ? { scannedAt: extra.scannedAt } : {})
	};
}

// ------------------------------------------------------------- device logs

export interface LogLine {
	ms?: number | null;
	message?: string | null;
}

/**
 * How a scan's wall-clock time was established, best first:
 *   transition       the state-transition line itself carries the device clock
 *                    ("T5 11-09 18:53:50 BARCODE_SCANNING>VALIDATING_MAGNETOMETER [..]")
 *   validation-file  the scan line is followed, in the same boot, by the write of
 *                    /validation/magnet-<epoch>.txt; the epoch minus the millis
 *                    between the two lines dates the scan
 *   session-time     a "Time: <ISO>" line earlier in the same boot anchors millis
 * A scan with none of these has `at: null` and is never used for matching:
 * `uploadedAt - maxMs + ms` (what the timeline page draws with) is only right
 * when the upload holds one boot, and uploads routinely hold several.
 */
export type ScanTiming = 'transition' | 'validation-file' | 'session-time';

export interface MagnetometerScan extends MagnetometerId {
	at: Date | null;
	timing: ScanTiming | null;
	/** millis-since-boot of the line, when it had one. */
	ms: number | null;
}

const TRANSITION_RE = /^T\d+\s+(\d{2})-(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+(\w+)>(\w+)\s+\[([^\]]*)\]/;
const SCAN_RE = /Barcode scan result:.*barcode:\s*([^)\s]+)/i;
const VALIDATION_FILE_RE = /Latest validation file:\s*\/validation\/magnet-(\d{9,13})\.txt/;
const SESSION_TIME_RE = /^Time:\s*(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/;

const EARLIEST = Date.UTC(2020, 0, 1);
/** A scan and the validation file it produced are seconds apart; two minutes is generous. */
const SCAN_TO_FILE_MAX_MS = 2 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A transition line has month-day and time but no year. The device clock is
 * UTC (checked against the validation-file epoch written 6 s later). Take the
 * latest year that does not put the line after the upload that carried it.
 */
function transitionTime(mo: number, d: number, h: number, mi: number, s: number, uploadedAt: Date): Date | null {
	if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
	const upload = uploadedAt.getTime();
	if (!Number.isFinite(upload)) return null;
	const year = uploadedAt.getUTCFullYear();
	for (const y of [year, year - 1]) {
		const t = Date.UTC(y, mo - 1, d, h, mi, s);
		// Rejects 02-30 and friends, which Date.UTC would roll forward.
		if (new Date(t).getUTCMonth() !== mo - 1) continue;
		if (t <= upload + DAY_MS && t >= EARLIEST) return new Date(t);
	}
	return null;
}

/**
 * Every magnetometer barcode scan in one uploaded log, with the time of each
 * where the log itself establishes it.
 *
 * Lines are NOT in time order across the upload: several boots are
 * concatenated and millis restarts with each, so a millis anchor is only
 * carried while millis keeps rising.
 */
export function extractMagnetometerScans(lines: LogLine[] | null | undefined, uploadedAt: Date): MagnetometerScan[] {
	const out: MagnetometerScan[] = [];
	if (!Array.isArray(lines)) return out;

	// Anchor for the current boot: millis `ms` was wall-clock `at`.
	let anchor: { ms: number; at: number } | null = null;
	let prevMs: number | null = null;

	for (let i = 0; i < lines.length; i++) {
		const msg = typeof lines[i]?.message === 'string' ? (lines[i].message as string).trim() : '';
		const rawMs = lines[i]?.ms;
		const ms = typeof rawMs === 'number' && Number.isFinite(rawMs) ? rawMs : null;

		// millis went backwards: a different boot. Whatever anchored the last one is void.
		if (ms !== null && prevMs !== null && ms < prevMs) anchor = null;
		if (ms !== null) prevMs = ms;
		if (!msg) continue;

		const st = SESSION_TIME_RE.exec(msg);
		if (st && ms !== null) {
			const at = Date.parse(st[1]);
			if (Number.isFinite(at) && at >= EARLIEST) anchor = { ms, at };
			continue;
		}

		const tr = TRANSITION_RE.exec(msg);
		if (tr) {
			// Only the transition INTO magnetometer validation is the scan. The
			// matching ...>IDLE line carries the same barcode ten seconds later.
			if (tr[7] !== 'VALIDATING_MAGNETOMETER') continue;
			const id = normaliseMagnetometerBarcode(tr[8]);
			if (!id) continue;
			const at = transitionTime(+tr[1], +tr[2], +tr[3], +tr[4], +tr[5], uploadedAt);
			out.push({ ...id, at, timing: at ? 'transition' : null, ms });
			continue;
		}

		const sc = SCAN_RE.exec(msg);
		if (!sc) continue;
		const id = normaliseMagnetometerBarcode(sc[1]);
		if (!id) continue;

		let at: number | null = null;
		let timing: ScanTiming | null = null;

		if (ms !== null) {
			// Look a few lines ahead, within this boot, for the validation file this
			// scan produced. The same "Latest validation file" text is also printed
			// at every boot for whatever old file is on disk, so it only counts when
			// the write itself is logged between the scan and it.
			let sawWrite = false;
			for (let j = i + 1; j < lines.length && j <= i + 8; j++) {
				const m2 = typeof lines[j]?.message === 'string' ? (lines[j].message as string) : '';
				const ms2 = lines[j]?.ms;
				if (typeof ms2 !== 'number' || ms2 < ms || ms2 - ms > SCAN_TO_FILE_MAX_MS) break;
				if (SCAN_RE.test(m2)) break;
				if (m2.includes('write_magnet_validation_to_file')) { sawWrite = true; continue; }
				const f = VALIDATION_FILE_RE.exec(m2);
				if (f && sawWrite) {
					const n = Number(f[1]);
					const epochMs = n >= 1e12 ? n : n * 1000;
					if (epochMs >= EARLIEST) { at = epochMs - (ms2 - ms); timing = 'validation-file'; }
					break;
				}
			}
			if (at === null && anchor && ms >= anchor.ms) {
				at = anchor.at + (ms - anchor.ms);
				timing = 'session-time';
			}
		}

		// A time after the upload that delivered the line cannot be right.
		if (at !== null && at > uploadedAt.getTime() + DAY_MS) { at = null; timing = null; }
		out.push({ ...id, at: at !== null ? new Date(at) : null, timing, ms });
	}

	return out;
}

/**
 * A `device-log` device event carries one upload chunk as text: `<ms>|<message>`
 * per line, base64 inside a data: URL when the device published it binary.
 * Accepts the string itself or the `{ raw }` wrapper the webhook stores.
 */
export function decodeDeviceLogEvent(eventData: unknown): LogLine[] {
	let text: string | null = null;
	if (typeof eventData === 'string') text = eventData;
	else if (eventData && typeof eventData === 'object') {
		const o = eventData as Record<string, unknown>;
		const inner = o.raw ?? o.data ?? o.text ?? null;
		if (typeof inner === 'string') text = inner;
	}
	if (!text) return [];

	const dataUrl = /^data:[^,]*;base64,/i.exec(text);
	if (dataUrl) {
		try {
			text = Buffer.from(text.slice(dataUrl[0].length), 'base64').toString('latin1');
		} catch {
			return [];
		}
	}

	const out: LogLine[] = [];
	for (const line of text.split(/\r?\n/)) {
		if (!line) continue;
		const bar = line.indexOf('|');
		const head = bar > 0 ? line.slice(0, bar) : '';
		if (bar > 0 && /^\d+$/.test(head)) out.push({ ms: Number(head), message: line.slice(bar + 1) });
		else out.push({ ms: null, message: line });
	}
	return out;
}

/** True when a line is worth fetching a log for. Cheap pre-filter for queries. */
export const MAGNETOMETER_LINE_RE = BARCODE_IN_TEXT;

export interface ScanWindow {
	/** How long before the reading a scan may be and still count. */
	beforeMs: number;
	/** Allowance for the scan appearing slightly AFTER the reading (clock skew). */
	afterMs: number;
}

/**
 * How far back a scan may sit from each kind of reading.
 *
 * mag        the five-point test runs seconds after the scan, and testRanAt is
 *            the device's own epoch for it, so the window is tight.
 * mag_sweep  the sweep is requested after the five-point test and takes ~19
 *            minutes; the reference time may be its start (device epoch) or
 *            the moment BIMS stored it (the end). Both magnetometers can be on
 *            the bench the same afternoon, so the window stays well under the
 *            time it takes to swap one for the other across a batch.
 */
export const SCAN_WINDOWS: Record<'mag' | 'mag_sweep', ScanWindow> = {
	mag: { beforeMs: 10 * 60 * 1000, afterMs: 2 * 60 * 1000 },
	mag_sweep: { beforeMs: 90 * 60 * 1000, afterMs: 2 * 60 * 1000 }
};

/**
 * The scan that applies to a reading taken at `readingAt`: the most recent
 * timed scan inside the window. Untimed scans are ignored. Returns null rather
 * than a doubtful match.
 */
export function chooseScan(scans: MagnetometerScan[], readingAt: Date, window: ScanWindow): MagnetometerScan | null {
	const ref = readingAt.getTime();
	if (!Number.isFinite(ref)) return null;
	let best: MagnetometerScan | null = null;
	for (const s of scans) {
		if (!s.at) continue;
		const t = s.at.getTime();
		if (t > ref + window.afterMs || ref - t > window.beforeMs) continue;
		if (!best || t > best.at!.getTime()) best = s;
	}
	return best;
}
