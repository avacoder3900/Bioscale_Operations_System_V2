/**
 * Compare stored sonic fingerprints (VALIDATION-08). Pure functions, no audio:
 * align recordings, cut the run into sections, and score every recording
 * against the others' (or the reference set's) mean ± K·σ. Port of compare(),
 * similarity(), phase_stats(), auto_sections(), section_shapes() and
 * score_sections() in the prototype spu_audio.py.
 */
import {
	FRAME_S, BIN_S, MAX_ALIGN_S, ACTIVE_RISE_DB, EVENT_GAP_S, PHASE_MIN_S, SECTION_GAP_MIN_S, LEVEL_SMOOTH_S,
	ENVELOPE_K, SIGMA_FLOOR_DB, SPEC_SIGMA_FLOOR_DB, PASS_INSIDE_PCT, MIN_REFERENCES, MIN_SPUS_FOR_ENVELOPE,
	FREQ_MATCH_PCT, EXTREME_PROM_HZ, EXTREME_MIN_S, MIN_FREQ, TONE_FLAG_DB
} from './constants';
import type { Fingerprint } from './features';
import { db, findPeaks, mean, median, movingAverageSame, percentile, std1 } from './stats';

export interface CompareItem {
	id: string;
	label: string;
	fp: Fingerprint;
}

export interface CompareOptions {
	/** '40-57, 110-130' — replaces the automatic P#/B# sections. */
	sections?: string | null;
	/** Score against these items (minus the item itself) instead of against each other. */
	referenceIds?: string[] | null;
}

export interface Section {
	name: string;
	a: number;
	b: number;
}

export interface SectionScore {
	loudIn: number;
	loudZ: number;
	specIn: number;
	specZ: number;
	pass: boolean;
}

export interface Similarity {
	dHz: (number | null)[];
	dLvl: number[];
	shapeDb: number[];
	runningS: number;
	avgAbsHz: number | null;
	avgAbsPct: number | null;
	matchPct: number | null;
	avgAbsLvl: number | null;
	avgShape: number | null;
	peakDb: number;
	peakT: number;
	minDb: number;
	minT: number;
	medianHz: number | null;
}

export interface SectionEnvelope {
	name: string;
	a: number;
	b: number;
	t: number[];
	loud: number[][];
	loudMu: number[];
	loudSd: number[];
	spec: number[][];
	specMu: number[];
	specSd: number[];
}

export interface CompareResult {
	mode: 'reference' | 'median';
	against: string;
	scoredAgainst: 'others' | 'references';
	referenceIdx: number[];
	offsets: number[];
	window: [number, number];
	t: number[];
	series: { level: number[]; levelSmooth: number[]; domHz: (number | null)[]; active: boolean[] }[];
	ref: { level: number[]; domHz: (number | null)[]; active: boolean[] };
	sim: Similarity[];
	phases: [number, number][];
	pstats: { avgDb: number; peakDb: number; hz: number | null }[][];
	extremes: [number, number, 'peak' | 'valley'][][];
	sections: Section[];
	sectionsCustom: boolean;
	scores: (SectionScore | null)[][];
	envelopes: SectionEnvelope[];
	tones: [number, number][][];
}

const nn = (v: number) => (Number.isNaN(v) ? null : v);

/** Seconds by which `env` lags `refEnv` (positive = starts later). */
export function alignOffset(refEnv: ArrayLike<number>, env: ArrayLike<number>): number {
	const z = (a: ArrayLike<number>) => {
		const m = mean(a);
		let s = 0;
		for (let i = 0; i < a.length; i++) s += (a[i] - m) ** 2;
		const sd = Math.sqrt(s / a.length) + 1e-9;
		return Float64Array.from(a, (v) => (v - m) / sd);
	};
	const a = z(refEnv);
	const b = z(env);
	const maxLag = Math.round(MAX_ALIGN_S / FRAME_S);
	let bestLag = 0;
	let best = -Infinity;
	for (let lag = -Math.min(maxLag, b.length - 1); lag <= Math.min(maxLag, a.length - 1); lag++) {
		// corr(lag) = Σ a[n + lag] · b[n]
		let s = 0;
		const n0 = Math.max(0, -lag);
		const n1 = Math.min(b.length, a.length - lag);
		for (let n = n0; n < n1; n++) s += a[n + lag] * b[n];
		if (s > best) {
			best = s;
			bestLag = lag;
		}
	}
	return bestLag === 0 ? 0 : -bestLag * FRAME_S; // never -0 (shows as "-0.00 s")
}

/** Sample a stored per-bin series at file time u (linear for levels, nearest for Hz). */
function sampler(fp: Fingerprint) {
	const nb = fp.levelDb.length;
	const pos = (u: number) => Math.min(Math.max(u / fp.binS - 0.5, 0), nb - 1);
	return {
		level(u: number) {
			const j = pos(u);
			const lo = Math.floor(j);
			const hi = Math.min(lo + 1, nb - 1);
			return fp.levelDb[lo] + (fp.levelDb[hi] - fp.levelDb[lo]) * (j - lo);
		},
		bands(u: number) {
			const j = pos(u);
			const lo = Math.floor(j);
			const hi = Math.min(lo + 1, nb - 1);
			const f = j - lo;
			return fp.bands[lo].map((v, k) => v + (fp.bands[hi][k] - v) * f);
		},
		dom(u: number) {
			const v = fp.domHz[Math.round(pos(u))];
			return v == null ? NaN : v;
		}
	};
}

export function parseSections(text: string, window: [number, number]): Section[] {
	const parts = text.split(/[,;]/).filter((p) => p.trim());
	return parts.map((part, k) => {
		const m = part.match(/^\s*(\d+(?:\.\d+)?)\s*[-–]\s*(\d+(?:\.\d+)?)\s*s?\s*$/);
		if (!m) throw new Error(`bad section '${part.trim()}' — use start-end in seconds, e.g. 110-130`);
		const a = Math.max(Number(m[1]), window[0]);
		const b = Math.min(Number(m[2]), window[1]);
		if (b - a < 1) {
			throw new Error(`section ${part.trim()} is outside the part every recording covers (${window[0].toFixed(0)}–${window[1].toFixed(0)} s)`);
		}
		return { name: `S${k + 1}`, a, b };
	});
}

export function autoSections(phases: [number, number][], window: [number, number]): Section[] {
	const out: Section[] = [];
	let cursor = window[0];
	let nb = 1;
	phases.forEach(([a, b], p) => {
		if (a - cursor >= SECTION_GAP_MIN_S) out.push({ name: `B${nb++}`, a: cursor, b: a });
		out.push({ name: `P${p + 1}`, a, b });
		cursor = b;
	});
	if (window[1] - cursor >= SECTION_GAP_MIN_S) out.push({ name: `B${nb}`, a: cursor, b: window[1] });
	return out;
}

/** For each row: % of points within mean ± K·σ of `others(i)`, and mean |z|. */
function scoreRows(X: number[][], floor: number, others: (i: number) => number[]) {
	return X.map((row, i) => {
		const o = others(i);
		let inside = 0;
		let zs = 0;
		for (let p = 0; p < row.length; p++) {
			const col = o.map((j) => X[j][p]);
			const mu = mean(col);
			const sd = Math.max(std1(col), floor);
			const z = Math.abs(row[p] - mu) / sd;
			if (z <= ENVELOPE_K) inside++;
			zs += z;
		}
		return { inside: row.length ? (inside / row.length) * 100 : 0, z: row.length ? zs / row.length : 0 };
	});
}

function band(X: number[][], idx: number[], floor: number) {
	const mu: number[] = [];
	const sd: number[] = [];
	for (let p = 0; p < X[0].length; p++) {
		const col = idx.map((j) => X[j][p]);
		mu.push(mean(col));
		sd.push(Math.max(std1(col), floor));
	}
	return { mu, sd };
}

export function compareFingerprints(items: CompareItem[], opts: CompareOptions = {}): CompareResult {
	if (items.length < 1) throw new Error('nothing to compare');
	const referenceIdx = (opts.referenceIds ?? [])
		.map((id) => items.findIndex((it) => it.id === id))
		.filter((i) => i >= 0);
	const againstRefs = (opts.referenceIds ?? null) !== null;
	const mode: 'reference' | 'median' = items.length === 2 && !againstRefs ? 'reference' : 'median';

	// 1. Align everyone to the first recording, then find the window all of them cover.
	let offsets = items.map((it, i) => (i === 0 ? 0 : alignOffset(items[0].fp.envDb, it.fp.envDb)));
	let start = Math.max(Math.max(...offsets.map((o) => -o)), 0);
	let end = Math.min(...items.map((it, i) => it.fp.durationS - offsets[i]));
	if (end - start < 5) {
		offsets = items.map(() => 0);
		start = 0;
		end = Math.min(...items.map((it) => it.fp.durationS));
	}
	const nb = Math.max(Math.floor((end - start) / BIN_S), 1);
	const t = Array.from({ length: nb }, (_, k) => start + (k + 0.5) * BIN_S);

	// 2. Resample each recording's stored bins onto the shared (reference-time) grid.
	const lvl: number[][] = [];
	const bnd: number[][][] = [];
	const dom: number[][] = [];
	const act: boolean[][] = [];
	items.forEach((it, i) => {
		const s = sampler(it.fp);
		const L = t.map((tk) => s.level(tk + offsets[i]));
		const quiet = percentile(L, 20);
		const A = L.map((v) => v > quiet + ACTIVE_RISE_DB);
		lvl.push(L);
		act.push(A);
		bnd.push(t.map((tk) => s.bands(tk + offsets[i])));
		dom.push(t.map((tk, k) => (A[k] ? s.dom(tk + offsets[i]) : NaN)));
	});

	// 3. Reference series: the first recording (2-way) or the per-bin group median.
	const ref =
		mode === 'reference'
			? { level: lvl[0], dom: dom[0], bands: bnd[0], active: act[0] }
			: {
					level: t.map((_, k) => median(lvl.map((L) => L[k]))),
					dom: t.map((_, k) => median(dom.map((D) => D[k]))),
					bands: t.map((_, k) => bnd[0][k].map((_, q) => median(bnd.map((B) => B[k][q])))),
					active: t.map((_, k) => median(act.map((A) => (A[k] ? 1 : 0))) >= 0.5)
				};

	// 4. Similarity over time (averages only while both are running).
	const sim: Similarity[] = items.map((_, i) => {
		const run = act[i].map((a, k) => a && ref.active[k]);
		const dHz = t.map((_, k) => (run[k] ? dom[i][k] - ref.dom[k] : NaN));
		const dPct = dHz.map((d, k) => (100 * Math.abs(d)) / ref.dom[k]);
		const dLvl = lvl[i].map((v, k) => v - ref.level[k]);
		const shapeDb = bnd[i].map((row, k) => {
			const d = row.map((v, q) => v - ref.bands[k][q]);
			const m = mean(d);
			return mean(d.map((v) => Math.abs(v - m)));
		});
		const valid = dPct.map((v) => !Number.isNaN(v));
		const nValid = valid.filter(Boolean).length;
		const runIdx = run.flatMap((r, k) => (r ? [k] : []));
		// Peak / min from the recording's own stored bins (interpolation would
		// soften short peaks), restricted to the shared window, in reference time.
		const fp = items[i].fp;
		let peakDb = -Infinity;
		let peakT = start;
		let minDb = Infinity;
		let minT = start;
		fp.levelDb.forEach((v, b) => {
			const tc = (b + 0.5) * fp.binS - offsets[i];
			if (tc < start || tc > end) return;
			if (v > peakDb) { peakDb = v; peakT = tc; }
			if (v < minDb) { minDb = v; minT = tc; }
		});
		return {
			dHz: dHz.map(nn),
			dLvl,
			shapeDb,
			runningS: runIdx.length * BIN_S,
			avgAbsHz: nValid ? mean(dHz.filter((v) => !Number.isNaN(v)).map(Math.abs)) : null,
			avgAbsPct: nValid ? mean(dPct.filter((v) => !Number.isNaN(v))) : null,
			matchPct: nValid ? (dPct.filter((v) => !Number.isNaN(v) && v <= FREQ_MATCH_PCT).length / nValid) * 100 : null,
			avgAbsLvl: runIdx.length ? mean(runIdx.map((k) => Math.abs(dLvl[k]))) : null,
			avgShape: runIdx.length ? mean(runIdx.map((k) => shapeDb[k])) : null,
			peakDb,
			peakT,
			minDb,
			minT,
			medianHz: nn(median(dom[i]))
		};
	});

	// 5. Operating phases from the reference/group running mask.
	const spans: [number, number][] = [];
	for (let k = 0; k < nb; k++) {
		if (!ref.active[k]) continue;
		let e = k;
		while (e + 1 < nb && ref.active[e + 1]) e++;
		const a = t[k] - BIN_S / 2;
		const b = t[e] + BIN_S / 2;
		const last = spans[spans.length - 1];
		if (last && a - last[1] < EVENT_GAP_S) last[1] = b;
		else spans.push([a, b]);
		k = e;
	}
	const phases = spans.filter(([a, b]) => b - a >= PHASE_MIN_S);
	const pstats = items.map((_, i) =>
		phases.map(([a, b]) => {
			const idx = t.flatMap((tk, k) => (tk >= a && tk <= b ? [k] : []));
			return {
				avgDb: db(mean(idx.map((k) => 10 ** (lvl[i][k] / 10)))),
				peakDb: Math.max(...idx.map((k) => lvl[i][k])),
				hz: nn(median(idx.map((k) => dom[i][k])))
			};
		})
	);

	// 6. Frequency peaks/valleys: highest & lowest of every running stretch.
	const extremes = items.map((_, i) => {
		const out: [number, number, 'peak' | 'valley'][] = [];
		for (let k = 0; k < nb; k++) {
			if (Number.isNaN(dom[i][k])) continue;
			let e = k;
			while (e + 1 < nb && !Number.isNaN(dom[i][e + 1])) e++;
			if ((e - k + 1) * BIN_S >= EXTREME_MIN_S) {
				let hi = k;
				let lo = k;
				for (let q = k; q <= e; q++) {
					if (dom[i][q] > dom[i][hi]) hi = q;
					if (dom[i][q] < dom[i][lo]) lo = q;
				}
				out.push([t[hi], dom[i][hi], 'peak']);
				if (dom[i][hi] - dom[i][lo] >= EXTREME_PROM_HZ) out.push([t[lo], dom[i][lo], 'valley']);
			}
			k = e;
		}
		return out.sort((x, y) => x[0] - y[0]);
	});

	// 7. Sections + section shapes + leave-one-out scoring.
	const window: [number, number] = [start, end];
	const sectionsCustom = !!opts.sections?.trim();
	const sections = sectionsCustom ? parseSections(opts.sections!, window) : autoSections(phases, window);
	const k = Math.max(Math.round(LEVEL_SMOOTH_S / BIN_S), 1);
	const smooth = lvl.map((L) => Array.from(movingAverageSame(L.map((v) => 10 ** (v / 10)), k), (p) => db(p)));
	const othersFor = (i: number) =>
		againstRefs ? referenceIdx.filter((j) => j !== i) : items.map((_, j) => j).filter((j) => j !== i);
	const minOthers = againstRefs ? MIN_REFERENCES : MIN_SPUS_FOR_ENVELOPE - 1;
	const scores: (SectionScore | null)[][] = items.map(() => []);
	const envelopes: SectionEnvelope[] = [];
	for (const s of sections) {
		const idx = t.flatMap((tk, q) => (tk >= s.a && tk <= s.b ? [q] : []));
		if (!idx.length) continue;
		const rows = smooth.map((S) => idx.map((q) => S[q]));
		const grand = mean(rows.flat());
		const loud = rows.map((r) => {
			const m = mean(r);
			return r.map((v) => v - m + grand);
		});
		const spec = bnd.map((B) => {
			const lv = B[0].map((_, q) => db(mean(idx.map((p) => 10 ** (B[p][q] / 10)))));
			const m = mean(lv);
			return lv.map((v) => v - m);
		});
		const l = scoreRows(loud, SIGMA_FLOOR_DB, othersFor);
		const sp = scoreRows(spec, SPEC_SIGMA_FLOOR_DB, othersFor);
		items.forEach((_, i) => {
			scores[i].push(
				othersFor(i).length >= minOthers
					? {
							loudIn: l[i].inside, loudZ: l[i].z, specIn: sp[i].inside, specZ: sp[i].z,
							pass: l[i].inside >= PASS_INSIDE_PCT && sp[i].inside >= PASS_INSIDE_PCT
						}
					: null
			);
		});
		const bandIdx = againstRefs && referenceIdx.length >= 2 ? referenceIdx : items.map((_, j) => j);
		const lb = bandIdx.length >= 2 ? band(loud, bandIdx, SIGMA_FLOOR_DB) : { mu: loud[0], sd: loud[0].map(() => 0) };
		const sb = bandIdx.length >= 2 ? band(spec, bandIdx, SPEC_SIGMA_FLOOR_DB) : { mu: spec[0], sd: spec[0].map(() => 0) };
		envelopes.push({ name: s.name, a: s.a, b: s.b, t: idx.map((q) => t[q]), loud, loudMu: lb.mu, loudSd: lb.sd, spec, specMu: sb.mu, specSd: sb.sd });
	}

	// 8. Narrowband tones present in one recording but not the others.
	const nPsd = Math.min(...items.map((it) => it.fp.psdDb.length));
	const df = items[0].fp.psdHzStep;
	const tones = items.map((it, i) => {
		const others =
			mode === 'reference' ? (i === 0 ? items.map((_, j) => j).slice(1) : [0]) : items.map((_, j) => j).filter((j) => j !== i);
		if (!others.length) return [];
		const kStart = Math.ceil(MIN_FREQ / df);
		const diff: number[] = [];
		for (let q = kStart; q < nPsd; q++) diff.push(it.fp.psdDb[q] - median(others.map((j) => items[j].fp.psdDb[q])));
		const m = median(diff);
		const d = diff.map((v) => v - m);
		return findPeaks(d, { height: TONE_FLAG_DB, prominence: TONE_FLAG_DB })
			.sort((x, y) => d[y.index] - d[x.index])
			.slice(0, 3)
			.map((p) => [Math.round((kStart + p.index) * df), Math.round(d[p.index] * 10) / 10] as [number, number]);
	});

	const against = againstRefs ? 'reference set' : mode === 'reference' ? items[0].label : 'group median';
	return {
		mode,
		against,
		scoredAgainst: againstRefs ? 'references' : 'others',
		referenceIdx,
		offsets,
		window,
		t,
		series: items.map((_, i) => ({
			level: lvl[i],
			levelSmooth: smooth[i],
			domHz: dom[i].map(nn),
			active: act[i]
		})),
		ref: { level: ref.level, domHz: ref.dom.map(nn), active: ref.active },
		sim,
		phases,
		pstats,
		extremes,
		sections,
		sectionsCustom,
		scores,
		envelopes,
		tones
	};
}
