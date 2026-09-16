import { requirePermission } from '$lib/server/permissions';
import { connectDB, OpticalBlankRun } from '$lib/server/db';
import { analyzeCartridge } from '$lib/server/optical-analysis';
import type { PageServerLoad } from './$types';

/**
 * Blank-cartridge runs (2026-09-15 plan): the same physical blank cartridge is
 * scanned on unit after unit to look at instrument noise with the chemistry
 * held constant. Runs arrive over the Particle webhook (firmware v95, event
 * `blank-test`) and live in optical_blank_runs — no cartridge records, nothing
 * to link or re-arm. Derive-on-read: every number here is computed from the
 * stored readings, over all 42 positions, and never written back.
 */
export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const runs = (await OpticalBlankRun.find()
		.select('deviceId spuId spuUdi barcode assayId startTime durationS numberOfReadings readings receivedAt')
		.sort({ startTime: -1 })
		.limit(400)
		.lean()) as any[];

	const rows = runs.map((r) => {
		const a = analyzeCartridge(r.readings ?? []);
		return {
			id: r._id as string,
			spuId: (r.spuId ?? null) as string | null,
			spuUdi: (r.spuUdi ?? r.deviceId) as string,
			barcode: (r.barcode ?? null) as string | null,
			startTime: r.startTime ? new Date(r.startTime).toISOString() : null,
			receivedAt: r.receivedAt ? new Date(r.receivedAt).toISOString() : null,
			numberOfReadings: (r.numberOfReadings ?? 0) as number,
			ratio: a?.ratioByChannel ?? { A: null, B: null, C: null },
			channelCv: {
				A: a?.channels.find((c) => c.channel === 'A')?.ratioCv ?? null,
				B: a?.channels.find((c) => c.channel === 'B')?.ratioCv ?? null,
				C: a?.channels.find((c) => c.channel === 'C')?.ratioCv ?? null
			},
			crossWellCv: a?.crossWellCv ?? null,
			warning: a?.warning ?? false,
			reasons: a?.reasons ?? []
		};
	});

	// Per device: how repeatable is the blank on this unit, and how does the
	// unit compare with the fleet on the same cartridge?
	const byDevice = new Map<string, typeof rows>();
	for (const r of rows) {
		if (!byDevice.has(r.spuUdi)) byDevice.set(r.spuUdi, []);
		byDevice.get(r.spuUdi)!.push(r);
	}
	const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
	const sd = (xs: number[]) => {
		if (xs.length < 2) return null;
		const m = mean(xs)!;
		return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
	};
	const devices = [...byDevice.entries()]
		.map(([udi, rs]) => {
			const per = (ch: 'A' | 'B' | 'C') => {
				const xs = rs.map((r) => r.ratio[ch]).filter((v): v is number => v != null);
				const m = mean(xs);
				const s = sd(xs);
				return { mean: m, sd: s, cv: m && s != null ? (s / m) * 100 : null, n: xs.length };
			};
			return { udi, spuId: rs[0].spuId, runs: rs, A: per('A'), B: per('B'), C: per('C'), latest: rs[0].startTime };
		})
		.sort((a, b) => a.udi.localeCompare(b.udi));

	// Fleet-wide per-channel spread across devices (latest run per device).
	const fleet = (['A', 'B', 'C'] as const).map((ch) => {
		const xs = devices.map((d) => d.runs[0]?.ratio[ch]).filter((v): v is number => v != null);
		const m = mean(xs);
		const s = sd(xs);
		return { channel: ch, n: xs.length, mean: m, sd: s, cv: m && s != null ? (s / m) * 100 : null };
	});

	return JSON.parse(JSON.stringify({ devices, fleet, total: rows.length }));
};
