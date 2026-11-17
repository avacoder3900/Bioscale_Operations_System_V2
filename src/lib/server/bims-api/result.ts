/**
 * BIMS API v1 — pure reducers for the result endpoint. No database import.
 *
 * `reduceResult` is the customer apps' `storedResult()` (bioscale-app
 * `src/lib/server/db/cartridges.ts`) moved here: it reads the stored
 * `analysis` block the cloud middleware wrote and reduces the analyte's
 * reported wells to one answer. Nothing is recomputed.
 */
import { ALL_WELLS, type WellId } from './analytes';

export type StoredQuant = {
	value?: number | null;
	unit?: string | null;
	status?: string | null;
	curveId?: string | null;
	curveVersion?: number | null;
	curveSource?: string | null;
};

export type StoredWell = {
	qc?: { pass?: boolean | null; flags?: { key?: string | null }[] | null } | null;
	quant?: StoredQuant | null;
};

export type StoredAnalysis = {
	schemaVersion?: number;
	engineVersion?: string | null;
	profileId?: string | null;
	profileName?: string | null;
	profileVersion?: number | null;
	computedAt?: string | null;
	quantifiedAt?: string | null;
	wells?: Record<string, StoredWell | null | undefined> | null;
};

export type ResultStatus =
	| 'ok'
	| 'below_range'
	| 'above_range'
	| 'qc_fail'
	| 'not_calibrated'
	/** A reported well's concentration is in a unit this API cannot turn into ng/mL. */
	| 'unit_unsupported';

export type WellDetail = {
	well: string;
	/** ng/mL. For a well out of range this is the curve's clamp bound, when it has one. */
	value: number | null;
	/** The well's own `quant.status`, as stored. */
	status: string | null;
	qcPass: boolean;
	flags: string[];
};

export type ReducedResult = {
	value: number | null;
	unit: 'ng/mL';
	status: ResultStatus;
	reportedWells: string[];
	wells: WellDetail[];
	qualityFlags: string[];
};

/**
 * Factor from a stored concentration unit to ng/mL, or null when there is no
 * unambiguous one. Mass-per-volume units only: a molar unit needs the
 * analyte's molar mass and is refused. An absent or empty unit is refused
 * too — calling it ng/mL would be relabelling.
 */
export function ngPerMlFactor(unit: string | null | undefined): number | null {
	const u = (unit ?? '').trim().toLowerCase().replace(/[µμ]/g, 'u').replace(/\s+/g, '');
	switch (u) {
		case 'ng/ml':
		case 'ug/l':
			return 1;
		case 'ug/dl':
			return 10;
		case 'ng/dl':
			return 0.01;
		case 'pg/ml':
			return 0.001;
		case 'ug/ml':
			return 1000;
		default:
			return null;
	}
}

const median = (xs: number[]): number | null => {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Reduce the reported wells of a stored analysis block.
 *
 * - value: median of the reported wells whose `quant.status` is `ok` and whose
 *   QC passed (`qc.pass` absent counts as passed); null otherwise.
 * - status precedence: ok > below_range > above_range > qc_fail > not_calibrated.
 * - qualityFlags: `qc.flags[].key` of the reported wells, de-duplicated, in well order.
 * - A well that is not reported contributes nothing, whatever it holds.
 */
export function reduceResult(analysis: StoredAnalysis | null | undefined, reported: readonly WellId[]): ReducedResult {
	const stored = analysis?.wells ?? {};
	const WELLS = ALL_WELLS.filter((w) => reported.includes(w));
	const present = WELLS.filter((w) => stored[w]);
	const well = (w: WellId) => stored[w] ?? {};

	const numeric = (w: WellId) => typeof well(w).quant?.value === 'number' && Number.isFinite(well(w).quant!.value as number);
	const factor = (w: WellId) => ngPerMlFactor(well(w).quant?.unit);
	// Only a well that carries a number has a unit that matters.
	const unitRefused = present.some((w) => numeric(w) && factor(w) === null);
	const valueOf = (w: WellId): number | null =>
		numeric(w) && factor(w) !== null ? (well(w).quant!.value as number) * (factor(w) as number) : null;

	const passes = (w: WellId) => well(w).quant?.status === 'ok' && (well(w).qc?.pass ?? true);
	const okValues = present.filter(passes).map(valueOf).filter((v): v is number => v !== null);
	const statuses = present.map((w) => well(w).quant?.status).filter(Boolean) as string[];
	const qcFailedAll = present.length > 0 && present.every((w) => well(w).qc?.pass === false);

	let status: ResultStatus;
	if (unitRefused) status = 'unit_unsupported';
	else if (okValues.length) status = 'ok';
	else if (statuses.includes('below_range')) status = 'below_range';
	else if (statuses.includes('above_range')) status = 'above_range';
	else if (qcFailedAll || statuses.includes('no_readout')) status = 'qc_fail';
	else status = 'not_calibrated';

	const flagsOf = (w: WellId) => (well(w).qc?.flags ?? []).map((f) => f?.key ?? '').filter(Boolean);

	return {
		value: status === 'ok' ? median(okValues) : null,
		unit: 'ng/mL',
		status,
		reportedWells: [...WELLS],
		wells: present.map((w) => ({
			well: w,
			value: unitRefused ? null : valueOf(w),
			status: well(w).quant?.status ?? null,
			qcPass: well(w).qc?.pass ?? true,
			flags: flagsOf(w)
		})),
		qualityFlags: [...new Set(present.flatMap(flagsOf))]
	};
}

export type CurveProvenance = { id: string | null; version: number | null; source: string | null };

/** The curve the first reported well with a `quant` block was read off. */
export function curveOf(analysis: StoredAnalysis | null | undefined, reported: readonly WellId[]): CurveProvenance {
	const stored = analysis?.wells ?? {};
	const q = ALL_WELLS.filter((w) => reported.includes(w)).map((w) => stored[w]?.quant).find(Boolean);
	return { id: q?.curveId ?? null, version: q?.curveVersion ?? null, source: q?.curveSource ?? null };
}

export type RunState = 'linked' | 'running' | 'completed' | 'cancelled';

/**
 * The run's state for the result endpoint.
 *
 * `completed` is only reported once the record is one the apps may show: the
 * cloud middleware has written a v2 analysis block (`analysis.schemaVersion`
 * 2) and the assay is one the API reports. Until then a finished run reads as
 * `running` with a `detail`.
 */
export function runState(
	status: string | null | undefined,
	visible: { analysed: boolean; knownAssay: boolean }
): { state: RunState; detail: 'analysis_pending' | 'assay_unsupported' | 'not_linked' | null } {
	switch (status ?? '') {
		case 'linked':
			return { state: 'linked', detail: null };
		case 'underway':
			return { state: 'running', detail: null };
		case 'completed':
			if (!visible.knownAssay) return { state: 'running', detail: 'assay_unsupported' };
			if (!visible.analysed) return { state: 'running', detail: 'analysis_pending' };
			return { state: 'completed', detail: null };
		case 'cancelled':
			return { state: 'cancelled', detail: null };
		default:
			// The link was made but the record has since left `linked` without a run
			// (voided, scrapped, or moved by a manufacturing page). No result will come.
			return { state: 'cancelled', detail: 'not_linked' };
	}
}

/** Any stored instant as an ISO-8601 UTC string; null when absent or not a date. */
export function iso(v: unknown): string | null {
	if (v === null || v === undefined || v === '') return null;
	const d = v instanceof Date ? v : new Date(v as string | number);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
