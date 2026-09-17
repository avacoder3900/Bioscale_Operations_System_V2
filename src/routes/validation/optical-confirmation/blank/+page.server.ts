import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpticalBlankRun } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * Blank-cartridge runs (2026-09-15 plan): the same physical blank cartridge is
 * scanned on unit after unit to look at instrument noise with the chemistry
 * held constant. Runs arrive over the Particle webhook (firmware v96, event
 * `blank-test`) and live in optical_blank_runs — no cartridge records, nothing
 * to link or re-arm.
 *
 * What is shown (Jacob, 2026-09-17): NOT the F7/F3 ratio. For every run, each
 * channel's raw band totals — the sum of F1, F2 … F8, Clear, NIR over that
 * channel's 42 reads ("the number before the division"). Derived on read,
 * never written back.
 *
 * Timestamps: the record's start_time is the device's millis-since-boot, not a
 * clock (it rendered as 1970), so rows are ordered and labelled by the moment
 * BIMS received the webhook.
 */
export const BANDS = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6', 'f7', 'f8', 'clear', 'nir'] as const;
export type Band = (typeof BANDS)[number];
const CH = ['A', 'B', 'C'] as const;
/** One full scan: 42 positions × 3 channels. Fewer = the run was cut short. */
const FULL_SCAN_READINGS = 126;

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const runs = (await OpticalBlankRun.find()
		.select('deviceId spuId spuUdi barcode assayId durationS numberOfReadings readings receivedAt publishedAt')
		.sort({ receivedAt: -1 })
		.limit(400)
		.lean()) as any[];

	const rows = runs.map((r) => {
		const readings: any[] = Array.isArray(r.readings) ? r.readings : [];
		const channels = CH.map((ch) => {
			const mine = readings.filter((x) => x?.channel === ch);
			const sums = Object.fromEntries(BANDS.map((b) => [b, mine.reduce((acc, x) => acc + (Number(x?.[b]) || 0), 0)])) as Record<Band, number>;
			return { channel: ch, n: mine.length, sums };
		});
		const n = (r.numberOfReadings ?? readings.length ?? 0) as number;
		return {
			id: r._id as string,
			spuId: (r.spuId ?? null) as string | null,
			spuUdi: (r.spuUdi ?? r.deviceId) as string,
			barcode: (r.barcode ?? null) as string | null,
			receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
			durationS: (r.durationS ?? null) as number | null,
			numberOfReadings: n,
			partial: n < FULL_SCAN_READINGS,
			channels
		};
	});

	const byDevice = new Map<string, typeof rows>();
	for (const r of rows) {
		if (!byDevice.has(r.spuUdi)) byDevice.set(r.spuUdi, []);
		byDevice.get(r.spuUdi)!.push(r);
	}
	const devices = [...byDevice.entries()]
		.map(([udi, rs]) => ({
			udi,
			spuId: rs[0].spuId,
			runs: rs,
			complete: rs.filter((r) => !r.partial).length,
			latest: rs[0].receivedAt
		}))
		.sort((a, b) => a.udi.localeCompare(b.udi));

	return JSON.parse(JSON.stringify({ devices, total: rows.length, bands: BANDS, fullScanReadings: FULL_SCAN_READINGS }));
};
