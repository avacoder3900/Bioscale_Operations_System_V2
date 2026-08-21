import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeRecord, CartridgeGroup, Spu } from '$lib/server/db';
import { compareGroups, type GroupInput } from '$lib/server/optical-analysis';
import {
	MAX_COMPARE_CARTRIDGES,
	isGroupColorKey,
	GROUP_COLOR_KEYS
} from '$lib/server/optical-constants';
import type { PageServerLoad } from './$types';

// Group-vs-group optical analysis. Accepts:
//   ?groups=<id>,<id>   named analysis cohorts (primary)
//   ?ids=<barcode>,...   an ad-hoc selection, kept so the log page's
//                        "Analyze selected" button works unchanged
//   &name=              display name for the ad-hoc set
//   &k=                 outlier threshold in robust SDs (default 3.5)
//   &windowK=           endpoint window size (default 10)
//
// Opaque ids rather than a name:ids grammar — group names are free text and will
// contain commas and colons.
//
// Derive-on-read throughout: nothing here writes to the DB.

function csv(raw: string | null): string[] {
	if (!raw) return [];
	return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
}

function numParam(raw: string | null, fallback: number, lo: number, hi: number): number {
	const n = Number(raw);
	return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : fallback;
}

export type CalibrationStatus = 'calibrated' | 'uncalibrated' | 'unknown';

export interface SpuContext {
	deviceId: string | null;
	deviceName: string | null;
	spuId: string | null;
	spuUdi: string | null;
	calibration: CalibrationStatus;
	/** Why we said what we said — an uncalibrated SPU must be explained, not just marked. */
	calibrationReason: string;
	factors: { A: number | null; B: number | null; C: number | null };
	calibratedAt: string | null;
	calibrationSetName: string | null;
}

function finiteOrNull(v: unknown): number | null {
	const n = Number(v);
	return Number.isFinite(n) ? n : null;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	requirePermission(locals.user, 'cartridge:read');
	await connectDB();

	const groupIds = csv(url.searchParams.get('groups'));
	const adhocIds = csv(url.searchParams.get('ids'));
	const adhocName = url.searchParams.get('name')?.trim() || 'Selection';

	const config = {
		madThreshold: numParam(url.searchParams.get('k'), 3.5, 1, 10),
		windowK: numParam(url.searchParams.get('windowK'), 10, 3, 50)
	};

	const empty = {
		comparison: null,
		spuContext: {} as Record<string, SpuContext>,
		groupColors: {} as Record<string, string>,
		config,
		truncated: false
	};

	// 1. The named cohorts. `?? []` because .lean() does not apply schema defaults.
	const groupDocs = groupIds.length
		? await CartridgeGroup.find({
				_id: { $in: groupIds },
				purpose: 'optical_analysis',
				archivedAt: null
			})
				.select('_id name color cartridgeIds')
				.lean()
		: [];

	// Preserve the order the user asked for rather than Mongo's.
	const orderedGroups = groupIds
		.map((id) => (groupDocs as any[]).find((g) => g._id === id))
		.filter(Boolean) as any[];

	const allIds = [
		...new Set([
			...orderedGroups.flatMap((g) => (g.cartridgeIds ?? []) as string[]),
			...adhocIds
		])
	];
	if (allIds.length === 0) return empty;

	// Each cartridge carries ~126 readings, so an uncapped ?ids= is a memory hazard.
	const truncated = allIds.length > MAX_COMPARE_CARTRIDGES;
	const usedIds = truncated ? allIds.slice(0, MAX_COMPARE_CARTRIDGES) : allIds;

	// 2. The cartridges. .lean() is REQUIRED: rawData and device are not declared on
	// the schema (brevitest-cloud writes them), so a hydrated strict document would
	// silently drop both.
	const docs = (await CartridgeRecord.find({ _id: { $in: usedIds } })
		.select('_id assayName assayCategory status createdAt checkpoints device rawData')
		.lean()) as any[];
	const byId = new Map(docs.map((d) => [d._id as string, d]));

	// 3. SPU + calibration, batched — one query regardless of group count.
	// Both join paths verified at 32/32 against production: device.id -> the Particle
	// device id, with device.name -> udi (uniquely indexed) as the fallback.
	const deviceIds = [...new Set(docs.map((d) => d.device?.id).filter(Boolean))] as string[];
	const deviceNames = [...new Set(docs.map((d) => d.device?.name).filter(Boolean))] as string[];

	const spus =
		deviceIds.length > 0 || deviceNames.length > 0
			? ((await Spu.find({
					$or: [
						{ 'particleLink.particleDeviceId': { $in: deviceIds } },
						{ udi: { $in: deviceNames } }
					]
				})
					.select('_id udi particleLink.particleDeviceId opticalCalibration')
					.lean()) as any[])
			: [];

	const spuByDevice = new Map<string, any>();
	const spuByUdi = new Map<string, any>();
	for (const s of spus) {
		if (s.particleLink?.particleDeviceId) spuByDevice.set(s.particleLink.particleDeviceId, s);
		if (s.udi) spuByUdi.set(s.udi, s);
	}

	const spuContext: Record<string, SpuContext> = {};
	for (const d of docs) {
		const deviceId: string | null = d.device?.id ?? null;
		const deviceName: string | null = d.device?.name ?? null;
		const spu =
			(deviceId ? spuByDevice.get(deviceId) : null) ??
			(deviceName ? spuByUdi.get(deviceName) : null) ??
			null;

		// opticalCalibration is written by the research app and is NOT declared on the
		// BIMS Spu schema — readable only thanks to .lean(). BIMS never writes it.
		const cal = spu?.opticalCalibration ?? null;
		const factors = {
			A: finiteOrNull(cal?.channels?.A?.factor),
			B: finiteOrNull(cal?.channels?.B?.factor),
			C: finiteOrNull(cal?.channels?.C?.factor)
		};
		const anyFactor = factors.A !== null || factors.B !== null || factors.C !== null;

		// Three states, never two: rendering "no SPU linked" as "uncalibrated" is a lie.
		let calibration: CalibrationStatus = 'unknown';
		let calibrationReason: string;
		if (!deviceId && !deviceName) {
			calibrationReason =
				'This cartridge record has no device block, so no SPU can be identified.';
		} else if (!spu) {
			calibrationReason = `No SPU record matches ${deviceName ?? deviceId} — calibration status is unknown.`;
		} else if (!cal) {
			calibrationReason = `${spu.udi} has no optical calibration on record.`;
		} else if (anyFactor) {
			calibration = 'calibrated';
			calibrationReason =
				`${spu.udi} calibration` +
				(cal.setName ? ` set "${cal.setName}"` : '') +
				(cal.setDate ? ` on ${new Date(cal.setDate).toLocaleDateString()}` : '') +
				`. Factors A ${factors.A?.toFixed(3) ?? '—'} / B ${factors.B?.toFixed(3) ?? '—'} / C ${factors.C?.toFixed(3) ?? '—'} (not applied — this page shows raw F7/F3).`;
		} else {
			calibration = 'uncalibrated';
			calibrationReason = `${spu.udi} has an optical calibration entry but no channel factors.`;
		}

		spuContext[d._id] = {
			deviceId,
			deviceName,
			spuId: spu?._id ?? null,
			spuUdi: spu?.udi ?? deviceName ?? null,
			calibration,
			calibrationReason,
			factors,
			calibratedAt: cal?.setDate ? new Date(cal.setDate).toISOString() : null,
			calibrationSetName: cal?.setName ?? null
		};
	}

	// 4. Build the group inputs.
	const inputs: GroupInput[] = [];
	const groupColors: Record<string, string> = {};

	const toItem = (id: string) => ({
		id,
		label: id, // cartridge_records _id IS the scanned barcode
		spuUdi: spuContext[id]?.spuUdi ?? null,
		readings: byId.get(id)?.rawData?.readings ?? []
	});

	for (const g of orderedGroups) {
		const ids = ((g.cartridgeIds ?? []) as string[]).filter((id) => byId.has(id));
		groupColors[g._id] = isGroupColorKey(g.color) ? g.color : 'cyan';
		inputs.push({
			groupId: g._id,
			groupName: g.name ?? '(unnamed)',
			items: ids.map(toItem)
		});
	}

	// Ad-hoc ?ids= not already covered by a named group become their own group, so the
	// log page's "Analyze selected" path keeps working unchanged.
	const claimed = new Set(inputs.flatMap((i) => i.items.map((it) => it.id)));
	const looseIds = adhocIds.filter((id) => byId.has(id) && !claimed.has(id));
	if (looseIds.length > 0) {
		groupColors.__adhoc = GROUP_COLOR_KEYS[inputs.length % GROUP_COLOR_KEYS.length];
		inputs.push({
			groupId: '__adhoc',
			groupName: adhocName,
			items: looseIds.map(toItem)
		});
	}

	if (inputs.length === 0) return empty;

	const comparison = compareGroups(inputs, config);

	return {
		comparison: JSON.parse(JSON.stringify(comparison)),
		spuContext: JSON.parse(JSON.stringify(spuContext)),
		groupColors,
		config,
		truncated
	};
};
