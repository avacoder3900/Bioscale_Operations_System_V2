import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB,
	Spu,
	ValidationSession,
	ValidationRun,
	CartridgeRecord,
	CartridgeGroup
} from '$lib/server/db';
import { analyzeCartridge, reportGroup } from '$lib/server/optical-analysis';
import { OPTICAL_CARTRIDGE_FILTER } from '$lib/server/optical-constants';
import type { RequestHandler } from './$types';

/**
 * Mirror of the BIMS Validation section for agents — one endpoint per sub-tab:
 *
 * - tab=runs                 → /validation/runs board (per-SPU step matrix)
 * - tab=magnetometer         → /validation/magnetometer sessions (per-well Z table)
 * - tab=thermocouple         → /validation/thermocouple sessions (temperature stats)
 * - tab=optical-confirmation → /validation/optical-confirmation log; with
 *   group=<name> the group workspace report (robust group stats + outliers)
 *
 * Common filters: spu (udi/barcode/_id/suffix), from, to, limit; runId for
 * tab=runs; group for tab=optical-confirmation.
 */

const TABS = ['runs', 'magnetometer', 'thermocouple', 'optical-confirmation'] as const;

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveSpu(ref: string): Promise<any | null> {
	const rx = new RegExp(`${escapeRegex(ref)}$`, 'i');
	return Spu.findOne({
		$or: [{ _id: ref }, { udi: ref }, { barcode: ref }, { udi: rx }, { barcode: rx }]
	})
		.select('_id udi barcode')
		.lean();
}

function dateRange(from?: Date, to?: Date): Record<string, Date> | null {
	if (!from && !to) return null;
	const r: Record<string, Date> = {};
	if (from) r.$gte = from;
	if (to) r.$lte = to;
	return r;
}

function thermoStats(readings: any[]): Record<string, number> | null {
	const temps = readings
		.map((r) => (typeof r?.temperature === 'number' ? r.temperature : null))
		.filter((t): t is number => t !== null);
	if (!temps.length) return null;
	const min = Math.min(...temps);
	const max = Math.max(...temps);
	const mean = temps.reduce((s, t) => s + t, 0) / temps.length;
	const sd = Math.sqrt(temps.reduce((s, t) => s + (t - mean) ** 2, 0) / temps.length);
	const r2 = (v: number) => Math.round(v * 1000) / 1000;
	return {
		readingCount: temps.length,
		min: r2(min),
		max: r2(max),
		average: r2(mean),
		stdDev: r2(sd),
		range: r2(max - min)
	};
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const q = url.searchParams;
	const tab = (q.get('tab') ?? '').toLowerCase();
	if (!TABS.includes(tab as any)) {
		throw error(400, `tab must be one of: ${TABS.join(', ')}`);
	}
	const spuRef = q.get('spu')?.trim();
	const groupRef = q.get('group')?.trim();
	const runId = q.get('runId')?.trim();
	const from = q.get('from') ? new Date(q.get('from')!) : undefined;
	const to = q.get('to') ? new Date(q.get('to')!) : undefined;
	const limit = Math.min(Number(q.get('limit')) || 50, 200);

	const spu = spuRef ? await resolveSpu(spuRef) : null;
	if (spuRef && !spu) {
		return json({ success: true, data: { tab, spuNotFound: spuRef } });
	}

	// ------------------------------------------------------------------ runs
	if (tab === 'runs') {
		const filter: Record<string, unknown> = {};
		if (runId) filter.$or = [{ _id: runId }, { runNumber: runId }];
		if (spu) filter['spus.udi'] = spu.udi;
		const range = dateRange(from, to);
		if (range) filter.createdAt = range;
		const runs = (await ValidationRun.find(filter)
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean()) as any[];
		return json({
			success: true,
			data: {
				tab,
				runs: runs.map((r) => ({
					id: r._id,
					runNumber: r.runNumber,
					name: r.name,
					status: r.status,
					steps: r.steps,
					createdAt: r.createdAt,
					spus: (r.spus ?? [])
						.filter((s: any) => !spu || s.udi === spu.udi)
						.map((s: any) => ({
							udi: s.udi,
							steps: Object.fromEntries(
								Object.entries(s.steps ?? {}).map(([step, v]: [string, any]) => [
									step,
									{
										status: v?.status ?? null,
										completedAt: v?.completedAt ?? null,
										result: v?.result ?? null,
										evaluation: v?.evaluation ?? null,
										notes: v?.notes ?? null,
										carriedOver: v?.carriedOver ?? false,
										previousAttempts: Array.isArray(v?.previous) ? v.previous.length : 0
									}
								])
							)
						}))
				}))
			}
		});
	}

	// -------------------------------------------------- magnetometer / thermo
	if (tab === 'magnetometer' || tab === 'thermocouple') {
		const aliases = tab === 'magnetometer' ? ['mag', 'magnetometer'] : ['thermo', 'thermocouple'];
		const filter: Record<string, unknown> = { type: { $in: aliases } };
		if (spu) {
			filter.$or = [
				{ spuId: spu._id },
				{ spuUdi: spu.udi },
				...(spu.barcode ? [{ barcode: spu.barcode }] : [])
			];
		}
		const range = dateRange(from, to);
		if (range) filter.createdAt = range;
		const docs = (await ValidationSession.find(filter)
			.select(
				'type spuId spuUdi barcode particleDeviceId status startedAt completedAt testRanAt overallPassed failureReasons override createdAt runId magResults criteriaUsed results'
			)
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean()) as any[];

		const sessions = docs.map((d) => {
			const base = {
				sessionId: d._id,
				spuUdi: d.spuUdi ?? null,
				barcode: d.barcode ?? null,
				runId: d.runId ?? null,
				status: d.status ?? null,
				overallPassed: d.overallPassed ?? null,
				failureReasons: d.failureReasons ?? [],
				overridden: !!d.override,
				testRanAt: d.testRanAt ?? null,
				startedAt: d.startedAt ?? null,
				completedAt: d.completedAt ?? null,
				recordedAt: d.createdAt ?? null
			};
			if (tab === 'magnetometer') {
				const criteria = d.criteriaUsed && typeof d.criteriaUsed === 'object' ? d.criteriaUsed : null;
				const inRange = (z: unknown): boolean | null =>
					typeof z === 'number' &&
					typeof criteria?.minZ === 'number' &&
					typeof criteria?.maxZ === 'number'
						? z >= criteria.minZ && z <= criteria.maxZ
						: null;
				return {
					...base,
					criteria,
					wells: Array.isArray(d.magResults)
						? d.magResults.map((w: any) => ({
								well: w.well,
								chA_Z: w.chA_Z ?? null,
								chA_pass: inRange(w.chA_Z),
								chB_Z: w.chB_Z ?? null,
								chB_pass: inRange(w.chB_Z),
								chC_Z: w.chC_Z ?? null,
								chC_pass: inRange(w.chC_Z)
							}))
						: []
				};
			}
			// thermocouple: prefer stored processed stats, else compute from readings.
			const res = Array.isArray(d.results) ? d.results.find((r: any) => r?.rawData || r?.processedData) : null;
			const stats =
				res?.processedData && typeof res.processedData === 'object'
					? res.processedData
					: thermoStats(res?.rawData?.readings ?? []);
			return { ...base, stats };
		});
		return json({ success: true, data: { tab, sessions } });
	}

	// -------------------------------------------------- optical-confirmation
	// Groups list always included, like the page's group workspace.
	const groups = (await CartridgeGroup.find({ archivedAt: null })
		.select('name purpose cartridgeIds color')
		.lean()) as any[];
	const groupSummaries = groups.map((g) => ({
		id: g._id,
		name: g.name,
		purpose: g.purpose ?? null,
		memberCount: (g.cartridgeIds ?? []).length
	}));

	if (groupRef) {
		const group = groups.find((g) => (g.name ?? '').toLowerCase() === groupRef.toLowerCase());
		if (!group) {
			return json({
				success: true,
				data: { tab, groupNotFound: groupRef, groups: groupSummaries }
			});
		}
		const carts = (await CartridgeRecord.find({ _id: { $in: group.cartridgeIds ?? [] } })
			.select('serialNumber device rawData createdAt')
			.lean()) as any[];
		const report = reportGroup({
			groupId: group._id,
			groupName: group.name,
			items: carts.map((c) => ({
				id: c._id,
				label: c.serialNumber ?? c._id,
				spuUdi: c.device?.name ?? null,
				readings: c.rawData?.readings ?? []
			}))
		});
		return json({ success: true, data: { tab, groupReport: report, groups: groupSummaries } });
	}

	const cartFilter: Record<string, unknown> = spu
		? { $and: [OPTICAL_CARTRIDGE_FILTER, { 'device.name': new RegExp(`^${escapeRegex(spu.udi)}$`, 'i') }] }
		: { ...OPTICAL_CARTRIDGE_FILTER };
	const range = dateRange(from, to);
	if (range) cartFilter.createdAt = range;
	const carts = (await CartridgeRecord.find(cartFilter)
		.select('serialNumber assayId assayName status statusUpdatedOn createdAt device rawData')
		.sort({ createdAt: -1 })
		.limit(limit)
		.lean()) as any[];
	const memberOf = new Map<string, string[]>();
	for (const g of groups) {
		for (const id of g.cartridgeIds ?? []) {
			if (!memberOf.has(id)) memberOf.set(id, []);
			memberOf.get(id)!.push(g.name);
		}
	}
	return json({
		success: true,
		data: {
			tab,
			groups: groupSummaries,
			cartridges: carts.map((c) => {
				const analysis = analyzeCartridge(c.rawData?.readings ?? []);
				return {
					barcode: c._id,
					serialNumber: c.serialNumber ?? null,
					assayId: c.assayId ?? null,
					assayName: c.assayName ?? null,
					status: c.status ?? null,
					createdAt: c.createdAt ?? null,
					spuUdi: c.device?.name ?? null,
					groups: memberOf.get(c._id) ?? [],
					hasReadings: Array.isArray(c.rawData?.readings) && c.rawData.readings.length > 0,
					ratioByChannel: analysis?.ratioByChannel ?? null,
					crossWellCv: analysis?.crossWellCv ?? null,
					warning: analysis?.warning ?? null,
					warningReasons: analysis?.reasons ?? []
				};
			})
		}
	});
};
