import { error } from '@sveltejs/kit';
import * as XLSX from 'xlsx';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Single-sweep magnetometer export.
 *
 * GET /spu/validation/magnetometer/sweep/export?sessionId=...
 *
 * Sweeps land as ValidationSession documents with a top-level `type: 'mag_sweep'`
 * ('magnetometer_sweep' is only the nested results[0].testType — matching on
 * that finds nothing; see sweep/+page.server.ts for the same note).
 *
 * Two sheets over the one run:
 *   "Summary"      — one row per (well, channel) from magResults.wells: the
 *                    derived peak/FWHM profile (or, for a travel-limited well,
 *                    the rising-tail slope fit — see below).
 *   "Raw Profile"  — the verbatim rawData.rows capture, expanded into columns
 *                    using rawData.fields as the header row.
 *
 * TRAVEL-LIMITED WELLS: well 5's field peak (~47000-49000) sits beyond
 * STAGE_POSITION_LIMIT (45000), so the stage runs out of travel before the
 * profile crests. For those wells the ingest endpoint (api/agent/validation/
 * mag-sweep) sets method:'slope' and characterises the rising tail via
 * slopePerMm/slopeR2 instead of a peak/FWHM the stage physically could not
 * reach. This is NOT a failed well and must not read like one: the Summary
 * sheet always carries Method/Travel Limited/Edge columns, and a slope-method
 * row leaves Peak/FWHM columns blank rather than printing a number that looks
 * like a real measurement.
 */

/** Excel silently mangles a bare Date in some locales; ISO strings sort correctly and stay unambiguous. */
function isoOrBlank(d: unknown): string {
	if (!d) return '';
	const parsed = d instanceof Date ? d : new Date(d as string);
	return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

/** null/undefined must stay an empty cell, not a 0 — a missing reading is not a zero field. */
function num(v: unknown): number | string {
	return typeof v === 'number' && Number.isFinite(v) ? v : '';
}

// Same cap the ingest endpoint enforces on the way in (api/agent/validation/mag-sweep),
// so no stored sweep should ever exceed this — kept here defensively so the Raw
// Profile sheet can never blow past a bound Excel/the response can't handle.
const MAX_RAW_EXPORT_ROWS = 20000;

export const GET: RequestHandler = async ({ url, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const sessionId = url.searchParams.get('sessionId');
	if (!sessionId) error(400, 'Provide ?sessionId= to export a sweep run.');

	const session = (await ValidationSession.findOne({
		_id: sessionId,
		type: 'mag_sweep'
	}).lean()) as any;

	if (!session) error(404, 'No sweep session found for the given sessionId.');

	const udi = session.spuUdi ?? '';
	const spuId = session.spuId ?? '';
	const startedAt = isoOrBlank(session.startedAt);
	const completedAt = isoOrBlank(session.completedAt ?? session.createdAt);

	const mag = session.magResults ?? {};
	const wells: Record<string, Record<string, any>> = mag.wells ?? {};
	const wellNumbers: number[] =
		Array.isArray(mag.wellNumbers) && mag.wellNumbers.length > 0
			? mag.wellNumbers
			: Object.keys(wells)
					.map(Number)
					.filter(Number.isFinite)
					.sort((a, b) => a - b);
	const channels: string[] =
		Array.isArray(mag.channels) && mag.channels.length > 0 ? mag.channels : ['A', 'B', 'C'];

	// ---- Summary sheet: one row per (well, channel) ----------------------
	const summary: (string | number)[][] = [
		[
			'SPU UDI',
			'SPU ID',
			'Session ID',
			'Started At',
			'Completed At',
			'Well',
			'Channel',
			'Method',
			'Travel Limited',
			'Edge',
			'Peak Y',
			'Peak |B|',
			'Peak Bx',
			'Peak By',
			'Peak Bz',
			'Baseline',
			'Amplitude',
			'FWHM',
			'Half Max Left Y',
			'Half Max Right Y',
			'Clipped',
			'Slope Per Mm',
			'Slope R2',
			'Slope Span Y Start',
			'Slope Span Y End',
			'Points',
			'Y Min',
			'Y Max'
		]
	];

	for (const well of wellNumbers) {
		const byChannel = wells[well] ?? wells[String(well)];
		if (!byChannel) continue;

		for (const ch of channels) {
			const p = byChannel[ch];
			if (!p) continue;

			const isSlope = p.method === 'slope';
			const isPeak = !isSlope;

			summary.push([
				udi,
				spuId,
				session._id,
				startedAt,
				completedAt,
				num(well),
				ch,
				p.method ?? '',
				p.travelLimited ? 'YES' : 'NO',
				p.edge ?? '',
				// A travel-limited (slope) well never crested — printing a peak/FWHM
				// for it would read as a real measurement the stage never took.
				isPeak ? num(p.peakY) : '',
				isPeak ? num(p.peakMag) : '',
				isPeak ? num(p.peakBx) : '',
				isPeak ? num(p.peakBy) : '',
				isPeak ? num(p.peakBz) : '',
				num(p.baseline),
				isPeak ? num(p.amplitude) : '',
				isPeak ? num(p.fwhm) : '',
				isPeak ? num(p.halfMaxLeftY) : '',
				isPeak ? num(p.halfMaxRightY) : '',
				typeof p.clipped === 'boolean' ? (p.clipped ? 'YES' : 'NO') : '',
				isSlope ? num(p.slopePerMm) : '',
				isSlope ? num(p.slopeR2) : '',
				isSlope && Array.isArray(p.slopeSpanY) ? num(p.slopeSpanY[0]) : '',
				isSlope && Array.isArray(p.slopeSpanY) ? num(p.slopeSpanY[1]) : '',
				num(p.points),
				num(p.yMin),
				num(p.yMax)
			]);
		}
	}

	// ---- Raw Profile sheet: verbatim rawData.rows, rawData.fields as headers ----
	const rawFields: string[] =
		Array.isArray(session.rawData?.fields) && session.rawData.fields.length > 0
			? session.rawData.fields
			: ['y', 'well', 'rep', 'tA', 'xA', 'yA', 'zA', 'tB', 'xB', 'yB', 'zB', 'tC', 'xC', 'yC', 'zC'];
	const rawRows: unknown[] = Array.isArray(session.rawData?.rows) ? session.rawData.rows : [];
	const truncated = rawRows.length > MAX_RAW_EXPORT_ROWS;
	const boundedRows = truncated ? rawRows.slice(0, MAX_RAW_EXPORT_ROWS) : rawRows;

	const rawProfile: (string | number)[][] = [[...rawFields]];
	for (const row of boundedRows) {
		if (!Array.isArray(row)) continue;
		rawProfile.push(rawFields.map((_, i) => num(row[i])));
	}
	if (truncated) {
		rawProfile.push(
			rawFields.map((_, i) =>
				i === 0 ? `TRUNCATED — showing first ${MAX_RAW_EXPORT_ROWS} of ${rawRows.length} rows` : ''
			)
		);
	}

	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summary), 'Summary');
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rawProfile), 'Raw Profile');

	const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
	const stamp = new Date().toISOString().slice(0, 10);
	const label = udi || sessionId;
	const fileName = `magnetometer-sweep-${label}-${stamp}.xlsx`;

	return new Response(new Uint8Array(buf), {
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="${fileName}"`,
			'Cache-Control': 'no-store'
		}
	});
};
