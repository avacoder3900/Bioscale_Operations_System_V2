// Thermocouple file parser (VALIDATION-05 QC fix).
// Only columns A, B, C are considered — thermocouple exports put time,
// temperature, and unit in the first three columns; anything beyond is
// ignored. Columns are classified by their DATA (not just headers), because
// real exports often carry a title row (e.g. "温度 datasheet") that defeats
// header-based detection and previously caused Excel date serials (~46,000)
// or row indexes (1,2,3…) to be read as temperatures.

export interface ThermoReading {
	timestamp: number;
	temperature: number;
}

export interface ThermoParseResult {
	readings: ThermoReading[];
	error?: string;
	// Which columns were used, for display ("temperature from column B")
	tempColumns: number[];
	timeColumn: number | null;
	columnsNote: string;
}

const MAX_COLS = 3;
const COL_NAMES = ['A', 'B', 'C'];
const TEMP_MIN = -100;
const TEMP_MAX = 1000;

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const UNIT_ONLY = /^[°℃℉cfCF\s]{1,4}$/;

function isEmpty(v: unknown): boolean {
	return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
}

// Parse a value as a point in time. Handles ms/sec epochs, Excel date
// serials, ISO-ish strings, and the logger's "HH:MM:SS YYYY-MM-DD" order.
// Plain numeric strings are NEVER treated as dates (Date.parse("23.8") can
// succeed in some engines).
function parseDateLike(v: unknown): number | null {
	if (typeof v === 'number') {
		if (!isFinite(v)) return null;
		if (v > 1e12) return v; // ms epoch
		if (v > 1e9) return v * 1000; // seconds epoch
		if (v > 25000 && v < 60000) {
			// Excel date serial (1900 system)
			return Date.UTC(1899, 11, 30) + v * 86400000;
		}
		return null;
	}
	if (typeof v !== 'string') return null;
	const s = v.trim();
	if (!s || PLAIN_NUMBER.test(s)) return null;
	let t = Date.parse(s);
	if (!isNaN(t)) return t;
	// "16:00:05 2026-06-15" → "2026-06-15T16:00:05"
	let m = s.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(\d{4}-\d{1,2}-\d{1,2})$/);
	if (m) {
		t = Date.parse(`${m[2]}T${m[1]}`);
		if (!isNaN(t)) return t;
	}
	// "16:00:05 6/15/2026"
	m = s.match(/^(\d{1,2}:\d{2}(?::\d{2})?)\s+(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})$/);
	if (m) {
		t = Date.parse(`${m[2]} ${m[1]}`);
		if (!isNaN(t)) return t;
	}
	return null;
}

function asNumber(v: unknown): number | null {
	if (typeof v === 'number') return isFinite(v) ? v : null;
	if (typeof v === 'string' && PLAIN_NUMBER.test(v.trim())) return Number(v.trim());
	return null;
}

type ColClass = 'empty' | 'unit' | 'time' | 'index' | 'temp' | 'other';

interface ColProfile {
	col: number;
	cls: ColClass;
	tempHint: boolean;
	timeHint: boolean;
}

function classifyColumn(values: unknown[]): ColClass {
	const nonEmpty = values.filter(v => !isEmpty(v));
	if (nonEmpty.length === 0) return 'empty';

	const unitish = nonEmpty.filter(v => typeof v === 'string' && UNIT_ONLY.test(v.trim())).length;
	if (unitish / nonEmpty.length >= 0.8) return 'unit';

	const dateish = nonEmpty.filter(v => parseDateLike(v) !== null).length;
	if (dateish / nonEmpty.length >= 0.6) return 'time';

	const nums = nonEmpty.map(asNumber).filter((n): n is number => n !== null);
	if (nums.length / nonEmpty.length >= 0.6 && nums.length >= 2) {
		// Row-index column: integers counting up by ~1 from a small start
		const isIndex = nums[0] < 10
			&& nums.every(n => Number.isInteger(n))
			&& nums.slice(1).every((n, i) => n - nums[i] === 1);
		if (isIndex) return 'index';
		const inRange = nums.filter(n => n >= TEMP_MIN && n <= TEMP_MAX).length;
		if (inRange / nums.length >= 0.6) return 'temp';
	}
	return 'other';
}

export function parseThermoRows(rows: unknown[][]): ThermoParseResult {
	const fail = (error: string): ThermoParseResult =>
		({ readings: [], error, tempColumns: [], timeColumn: null, columnsNote: '' });

	if (!rows || rows.length < 2) return fail('File has no data rows');

	// Header/title hints from the first few rows (first 3 columns only)
	const tempHints = new Set<number>();
	const timeHints = new Set<number>();
	for (const row of rows.slice(0, 5)) {
		for (let col = 0; col < MAX_COLS; col++) {
			const v = row?.[col];
			if (typeof v !== 'string') continue;
			const h = v.toLowerCase().trim();
			if (!h || PLAIN_NUMBER.test(h)) continue;
			if (h.includes('temp') || h.includes('°c') || h.includes('℃') || h.includes('celsius') || h.includes('温度') || /^ch\s?\d/.test(h)) {
				tempHints.add(col);
			}
			if (h.includes('time') || h.includes('date') || h.includes('elapsed') || h.includes('timestamp')) {
				timeHints.add(col);
			}
		}
	}

	// Classify each of the first 3 columns from data content (sample up to 300)
	const sample = rows.slice(0, 300);
	const profiles: ColProfile[] = [];
	for (let col = 0; col < MAX_COLS; col++) {
		profiles.push({
			col,
			cls: classifyColumn(sample.map(r => r?.[col])),
			tempHint: tempHints.has(col),
			timeHint: timeHints.has(col)
		});
	}

	// Temperature column(s): hinted temp-classified first; else any
	// temp-classified, preferring B, then C, then A (time usually leads).
	let tempCols = profiles.filter(p => p.cls === 'temp' && p.tempHint).map(p => p.col);
	if (tempCols.length === 0) {
		tempCols = profiles
			.filter(p => p.cls === 'temp' && !p.timeHint)
			.map(p => p.col)
			.sort((a, b) => ((a + 2) % 3) - ((b + 2) % 3)); // B < C < A
	}
	if (tempCols.length === 0) {
		return fail('Could not find a temperature column in columns A–C. Expected numeric readings (e.g. 23.8) with a header like "Temp", "°C", or "CH1".');
	}

	// Time column: hinted time-classified; else first time-classified; else an
	// index column doubles as elapsed seconds; else synthetic 1 reading/sec.
	const timeCol =
		profiles.find(p => p.cls === 'time' && p.timeHint)?.col
		?? profiles.find(p => p.cls === 'time')?.col
		?? null;
	const indexCol = timeCol === null
		? profiles.find(p => p.cls === 'index' && !tempCols.includes(p.col))?.col ?? null
		: null;

	const startTime = Date.now();
	const readings: ThermoReading[] = [];
	for (let i = 0; i < rows.length; i++) {
		const row = rows[i];
		if (!row || row.length === 0) continue;

		// Average across temperature columns (multi-channel exports); the
		// typical single-channel file has exactly one.
		const temps = tempCols.map(c => asNumber(row[c])).filter((n): n is number => n !== null);
		if (temps.length === 0) continue; // header/title/blank rows fall out here
		const temperature = temps.reduce((a, b) => a + b, 0) / temps.length;

		let ts: number | null = null;
		if (timeCol !== null) ts = parseDateLike(row[timeCol]);
		if (ts === null && indexCol !== null) {
			const idx = asNumber(row[indexCol]);
			if (idx !== null) ts = startTime + idx * 1000; // elapsed readings
		}
		if (ts === null) ts = startTime + readings.length * 1000;

		readings.push({ timestamp: ts, temperature });
	}

	if (readings.length === 0) return fail('No valid temperature readings found in columns A–C');

	readings.sort((a, b) => a.timestamp - b.timestamp);

	const columnsNote = `temperature from column ${tempCols.map(c => COL_NAMES[c]).join('+')}`
		+ (timeCol !== null ? `, time from column ${COL_NAMES[timeCol]}`
			: indexCol !== null ? `, elapsed from column ${COL_NAMES[indexCol]}`
			: ', 1 reading/sec assumed');

	return { readings, tempColumns: tempCols, timeColumn: timeCol, columnsNote };
}
