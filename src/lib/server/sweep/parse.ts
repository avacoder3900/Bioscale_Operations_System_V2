/**
 * Magnetometer stage-sweep text → rawData, for sweeps that arrive over the
 * cloud (firmware v98+ `run_sweep` → `/sweep` file → `bioscale/mag_sweep_chunk`).
 *
 * The file the device writes (brevitest-firmware.ino create_sweep_file /
 * write_sweep_position_rows / close_sweep_file):
 *
 *   SWPBEGIN\tfmt=3\tfw=101\tid=1760000000\ty0=1000\ty1=40000\tdy=200\tn=8\tsettle=250
 *           \tpoints=196\twells=5\tscale=100\tzscale=0.25\tformat=spu-mag-sweep-means/v1
 *           \tfields=y,well,tA,xA,yA,zA,sdA,tB,xB,yB,zB,sdB,tC,xC,yC,zC,sdC
 *   M\t<y>\t<well>\t<tA*100>\t<xA*100>\t<yA*100>\t<zA*100>\t<sdA*100>\t...   (one per position × well)
 *   SWPEND\trows=980\tgood=7840\tms=1135271
 *
 * Every value in an M row is an INTEGER = raw device units × scale (the firmware
 * emits no floating point). sd = −1 (scaled −100) means "no spread": nothing was
 * read at that well/position or a single reading. The receiver resolves columns
 * BY NAME from the header's fields= list, never by offset — the viewer and this
 * parser both depend on that.
 *
 * The 32 sessions already in validation_sessions (type 'mag_sweep') came from
 * USB serial captures at fmt=2 (one row per rep, unscaled floats, fields
 * y,well,rep,tA,xA,yA,zA,…). rawData keeps the same shape for both so one
 * analysis (./analyze.ts) serves old and new.
 */

export interface SweepMeta {
	fmt: number;
	fw: number | null;
	id: string | null;
	y0: number;
	y1: number;
	dy: number;
	n: number;
	settle: number;
	points: number;
	wells: number;
	scale: number;
	zscale: number;
	format: string | null;
	/**
	 * Peaks-only ("segmented") sweep, firmware v102+: seg = number of segments
	 * (1 = classic continuous sweep, pitch 0), pitch = well-to-well peak spacing
	 * in µm. In segment k the device reads ONLY well k+1, so at a given y the M
	 * rows for the other wells are simply absent — "not sampled", never zero.
	 * Each well's window is therefore the y-range of its own rows.
	 */
	seg: number;
	pitch: number;
}

export interface SweepRawData {
	format: string;
	meta: SweepMeta;
	/** SWPEND trailer, when present. */
	end: { rows: number; good: number; ms: number } | null;
	fields: string[];
	/** Numeric rows in device units (already divided by `scale`). */
	rows: number[][];
	sourceFile?: string;
	/** Rows the header promised but the file did not carry (abort or lost chunk). */
	rowsMissing: number;
}

function kv(line: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of line.split('\t').slice(1)) {
		const eq = part.indexOf('=');
		if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
	}
	return out;
}

const num = (v: string | undefined, d: number) => {
	const n = Number(v);
	return Number.isFinite(n) ? n : d;
};

/** Parse the whole sweep text. Returns an error string when it is not a sweep file. */
export function parseSweepText(text: string): SweepRawData | { error: string } {
	const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
	const headerLine = lines.find((l) => l.startsWith('SWPBEGIN'));
	if (!headerLine) return { error: 'No SWPBEGIN header in the sweep text' };
	const h = kv(headerLine);
	const fields = (h.fields ?? '').split(',').map((f) => f.trim()).filter(Boolean);
	if (!fields.includes('y') || !fields.includes('well')) {
		return { error: `Sweep header does not declare y/well columns (fields=${h.fields ?? ''})` };
	}
	const scale = num(h.scale, 1) || 1;
	const meta: SweepMeta = {
		fmt: num(h.fmt, 3),
		fw: h.fw != null ? num(h.fw, 0) : null,
		id: h.id ?? null,
		y0: num(h.y0, 0),
		y1: num(h.y1, 0),
		dy: num(h.dy, 0),
		n: num(h.n, 1),
		settle: num(h.settle, 0),
		points: num(h.points, 0),
		wells: num(h.wells, 5),
		scale,
		zscale: num(h.zscale, 0.25),
		format: h.format ?? null,
		seg: Math.max(1, num(h.seg, 1)),
		pitch: num(h.pitch, 0)
	};

	const rows: number[][] = [];
	let end: SweepRawData['end'] = null;
	for (const line of lines) {
		if (line.startsWith('M\t') || line.startsWith('S\t')) {
			const cells = line.split('\t').slice(1);
			if (cells.length < fields.length) continue; // truncated row: drop, count as missing below
			const row = cells.slice(0, fields.length).map((c, i) => {
				const v = Number(c);
				if (!Number.isFinite(v)) return NaN;
				// y, well and rep are positions/indices, never scaled.
				const f = fields[i];
				if (f === 'y' || f === 'well' || f === 'rep') return v;
				return v / scale;
			});
			if (row.some((v) => Number.isNaN(v))) continue;
			rows.push(row);
		} else if (line.startsWith('SWPEND')) {
			const e = kv(line);
			end = { rows: num(e.rows, 0), good: num(e.good, 0), ms: num(e.ms, 0) };
		}
	}
	const promised = end?.rows ?? meta.points * meta.wells;
	return {
		format: meta.format ?? 'spu-mag-sweep-means/v1',
		meta,
		end,
		fields,
		rows,
		rowsMissing: Math.max(0, promised - rows.length)
	};
}
