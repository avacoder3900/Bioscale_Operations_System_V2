import { error } from '@sveltejs/kit';
import * as XLSX from 'xlsx';
import { requirePermission } from '$lib/server/permissions';
import { connectDB, ValidationSession, Spu } from '$lib/server/db';
import type { RequestHandler } from './$types';

/**
 * Multi-SPU magnetometer export.
 *
 * GET /validation/magnetometer/export?spuIds=a,b,c
 *
 * Returns a single .xlsx with two sheets over the SAME rows, because the two
 * shapes answer different questions:
 *   "Per Well"    — one row per well, all 12 channel columns side by side.
 *                   Mirrors the raw device dump, so it reads like the bench output.
 *   "Per Channel" — one row per (well, channel), tidy/long. This is the sheet to
 *                   pivot on when comparing many SPUs at once.
 *
 * Every magnetometer run for each SPU is included (full history), with the
 * session date on every row so runs stay separable after sorting.
 */

const CHANNELS = ['A', 'B', 'C'] as const;

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

export const GET: RequestHandler = async ({ url, locals }) => {
	requirePermission(locals.user, 'spu:read');
	await connectDB();

	const spuIds = (url.searchParams.get('spuIds') ?? '')
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);

	if (spuIds.length === 0) error(400, 'Select at least one SPU to export.');

	const sessions = (await ValidationSession.find({
		type: 'mag',
		spuId: { $in: spuIds }
	})
		.sort({ testRanAt: 1, completedAt: 1, createdAt: 1 })
		.lean()) as any[];

	if (sessions.length === 0) {
		error(404, 'No magnetometer runs recorded for the selected SPUs.');
	}

	// spuUdi is denormalised onto the session at write time, but fall back to the
	// SPU document so rows for older sessions still carry a readable label.
	const udiById = new Map<string, string>();
	const spus = (await Spu.find({ _id: { $in: spuIds } }, { udi: 1 }).lean()) as any[];
	for (const s of spus) udiById.set(s._id, s.udi);

	const perWell: (string | number)[][] = [
		[
			'SPU UDI',
			'SPU ID',
			'Session ID',
			'Test Ran At',
			'Recorded At',
			'Result',
			'Min Z',
			'Max Z',
			'Well',
			'chA_T', 'chA_X', 'chA_Y', 'chA_Z',
			'chB_T', 'chB_X', 'chB_Y', 'chB_Z',
			'chC_T', 'chC_X', 'chC_Y', 'chC_Z'
		]
	];

	const perChannel: (string | number)[][] = [
		[
			'SPU UDI',
			'SPU ID',
			'Session ID',
			'Test Ran At',
			'Recorded At',
			'Result',
			'Min Z',
			'Max Z',
			'Well',
			'Channel',
			'T',
			'X',
			'Y',
			'Z',
			'Z In Range'
		]
	];

	for (const session of sessions) {
		const udi = session.spuUdi ?? udiById.get(session.spuId) ?? '';
		// Two distinct timestamps, and they are routinely DAYS apart:
		//   testRanAt  — when the device actually ran the sweep (firmware-reported)
		//   recordedAt — when BIMS fetched magnet_validation off the device
		// Re-reading the device variable without re-running the test creates a second
		// session with the same testRanAt but different readings, so neither column
		// alone identifies a run. Both are exported; nothing is de-duplicated here.
		const testRanAt = isoOrBlank(session.testRanAt);
		const recordedAt = isoOrBlank(session.completedAt ?? session.createdAt);
		const result = session.overallPassed === true ? 'PASS' : session.overallPassed === false ? 'FAIL' : '';
		const minZ = num(session.criteriaUsed?.minZ);
		const maxZ = num(session.criteriaUsed?.maxZ);
		const wells: any[] = Array.isArray(session.magResults) ? session.magResults : [];

		for (const well of wells) {
			perWell.push([
				udi, session.spuId ?? '', session._id, testRanAt, recordedAt, result, minZ, maxZ,
				num(well.well),
				num(well.chA_T), num(well.chA_X), num(well.chA_Y), num(well.chA_Z),
				num(well.chB_T), num(well.chB_X), num(well.chB_Y), num(well.chB_Z),
				num(well.chC_T), num(well.chC_X), num(well.chC_Y), num(well.chC_Z)
			]);

			for (const ch of CHANNELS) {
				const z = well[`ch${ch}_Z`];
				// Only the Z axis is gated by the pass/fail criteria, matching readFromDevice.
				const inRange =
					typeof z === 'number' && typeof minZ === 'number' && typeof maxZ === 'number'
						? z >= minZ && z <= maxZ
							? 'YES'
							: 'NO'
						: '';

				perChannel.push([
					udi, session.spuId ?? '', session._id, testRanAt, recordedAt, result, minZ, maxZ,
					num(well.well),
					ch,
					num(well[`ch${ch}_T`]),
					num(well[`ch${ch}_X`]),
					num(well[`ch${ch}_Y`]),
					num(z),
					inRange
				]);
			}
		}
	}

	const wb = XLSX.utils.book_new();
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(perWell), 'Per Well');
	XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(perChannel), 'Per Channel');

	const buf: Buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
	const stamp = new Date().toISOString().slice(0, 10);
	const fileName = `magnetometer-${spuIds.length}-spu-${stamp}.xlsx`;

	return new Response(new Uint8Array(buf), {
		headers: {
			'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'Content-Disposition': `attachment; filename="${fileName}"`,
			'Cache-Control': 'no-store'
		}
	});
};
