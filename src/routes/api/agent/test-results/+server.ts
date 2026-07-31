import { json, error } from '@sveltejs/kit';
import { requireAgentApiKey } from '$lib/server/api-auth';
import {
	connectDB,
	Spu,
	ValidationSession,
	ValidationRun,
	CartridgeRecord,
	CartridgeGroup,
	OpticalTestCartridge
} from '$lib/server/db';
import { analyzeCartridge } from '$lib/server/optical-analysis';
import { OPTICAL_CARTRIDGE_FILTER } from '$lib/server/optical-constants';
import type { RequestHandler } from './$types';

/**
 * Cross-domain test-result resolver for agents — ANY outcome, not just failures.
 *
 * Test results in BIMS do NOT live in one place. This endpoint fans out to the
 * real stores by modality:
 * - magnetometer / thermocouple / spectrophotometer → validation_sessions
 *   (stored type values: 'mag', 'thermo', 'spectrophotometer' + legacy aliases)
 * - optical → the Optical Test Cartridge Log domain: cartridge_records matching
 *   the optical filter, analyzed derive-on-read (ratios per channel), with
 *   cartridge_groups resolving group names and optical_test_cartridges /
 *   validation_runs linking cartridges to SPUs.
 *
 * GET params: modality (magnetometer|thermocouple|spectrophotometer|optical|all),
 * spu (udi / barcode / _id / unique suffix), cartridge (barcode/serial), group
 * (cartridge group name), passed (true|false), from, to (ISO dates), limit.
 */

const TYPE_ALIASES: Record<string, string[]> = {
	magnetometer: ['mag', 'magnetometer'],
	thermocouple: ['thermo', 'thermocouple'],
	spectrophotometer: ['spectrophotometer']
};

function normalizeModality(t: string | undefined | null): string {
	const s = (t ?? '').toLowerCase();
	if (s === 'mag') return 'magnetometer';
	if (s === 'thermo') return 'thermocouple';
	return s;
}

function escapeRegex(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function resolveSpu(ref: string): Promise<any | null> {
	const rx = new RegExp(`${escapeRegex(ref)}$`, 'i');
	return Spu.findOne({
		$or: [{ _id: ref }, { udi: ref }, { barcode: ref }, { udi: rx }, { barcode: rx }]
	})
		.select('_id udi barcode status')
		.lean();
}

export const GET: RequestHandler = async ({ request, url }) => {
	requireAgentApiKey(request);
	await connectDB();

	const q = url.searchParams;
	const modality = (q.get('modality') ?? 'all').toLowerCase();
	const spuRef = q.get('spu')?.trim();
	const cartridgeRef = q.get('cartridge')?.trim();
	const groupRef = q.get('group')?.trim();
	const passedParam = q.get('passed');
	const passed = passedParam === 'true' ? true : passedParam === 'false' ? false : undefined;
	const from = q.get('from') ? new Date(q.get('from')!) : undefined;
	const to = q.get('to') ? new Date(q.get('to')!) : undefined;
	const limit = Math.min(Number(q.get('limit')) || 50, 200);

	const wantsOptical = modality === 'optical' || modality === 'optics' || modality === 'all';
	const wantsSessions = modality !== 'optical' && modality !== 'optics';

	const spu = spuRef ? await resolveSpu(spuRef) : null;
	if (spuRef && !spu) {
		return json({
			success: true,
			data: { spuNotFound: spuRef, validationSessions: [], optical: null }
		});
	}

	// ------------------------------------------------ validation sessions
	let sessions: any[] = [];
	if (wantsSessions) {
		const filter: Record<string, unknown> = {};
		if (modality !== 'all') {
			const aliases = TYPE_ALIASES[modality];
			if (!aliases) {
				throw error(
					400,
					`Unknown modality '${modality}'. Use magnetometer, thermocouple, spectrophotometer, optical, or all.`
				);
			}
			filter.type = { $in: aliases };
		}
		if (spu) {
			filter.$or = [
				{ spuId: spu._id },
				{ spuUdi: spu.udi },
				...(spu.barcode ? [{ barcode: spu.barcode }] : [])
			];
		}
		if (passed !== undefined) filter.overallPassed = passed;
		if (from || to) {
			const range: Record<string, Date> = {};
			if (from) range.$gte = from;
			if (to) range.$lte = to;
			filter.createdAt = range;
		}
		const docs = await ValidationSession.find(filter)
			.select(
				'type spuId spuUdi barcode particleDeviceId status startedAt completedAt testRanAt overallPassed failureReasons override createdAt results.testType results.passed results.notes'
			)
			.sort({ createdAt: -1 })
			.limit(limit)
			.lean();
		sessions = (docs as any[]).map((d) => ({
			source: 'validation_sessions',
			modality: normalizeModality(d.type),
			spuUdi: d.spuUdi ?? null,
			spuId: d.spuId ?? null,
			particleDeviceId: d.particleDeviceId ?? null,
			status: d.status ?? null,
			overallPassed: d.overallPassed ?? null,
			failureReasons: d.failureReasons ?? [],
			overridden: !!d.override,
			testRanAt: d.testRanAt ?? null,
			recordedAt: d.createdAt ?? d.startedAt ?? null,
			subResults: (d.results ?? []).map((r: any) => ({
				testType: r.testType,
				passed: r.passed,
				notes: r.notes
			}))
		}));
	}

	// --------------------------------------------------------- optical
	let optical: any = null;
	if (wantsOptical) {
		let cartFilter: Record<string, unknown> | null = null;
		let groupInfo: any = null;

		if (groupRef) {
			const group = (await CartridgeGroup.findOne({
				name: new RegExp(`^${escapeRegex(groupRef)}$`, 'i'),
				archivedAt: null
			}).lean()) as any;
			if (!group) {
				optical = { groupNotFound: groupRef, cartridges: [] };
			} else {
				groupInfo = {
					id: group._id,
					name: group.name,
					purpose: group.purpose,
					memberCount: (group.cartridgeIds ?? []).length
				};
				cartFilter = { _id: { $in: group.cartridgeIds ?? [] } };
			}
		} else if (cartridgeRef) {
			cartFilter = {
				$or: [{ _id: cartridgeRef }, { serialNumber: cartridgeRef }],
				...{}
			};
		} else if (spu) {
			// SPU → optical cartridges via the optical log's usage entries and
			// any validation-run optical_confirmation step for this SPU.
			const [optCarts, runs] = await Promise.all([
				OpticalTestCartridge.find({ 'usageLog.spuId': spu._id }).select('barcode serialNumber').lean(),
				ValidationRun.find({ 'spus.udi': spu.udi }).select('runNumber name spus.udi spus.steps').lean()
			]);
			const barcodes = (optCarts as any[]).map((c) => c.barcode).filter(Boolean);
			const runSteps = (runs as any[]).flatMap((r) =>
				(r.spus ?? [])
					.filter((s: any) => s.udi === spu.udi && s.steps?.optical_confirmation)
					.map((s: any) => ({
						runNumber: r.runNumber,
						runName: r.name,
						optical_confirmation: s.steps.optical_confirmation
					}))
			);
			for (const step of runSteps) {
				const bc = step.optical_confirmation?.cartridgeBarcode;
				if (bc) barcodes.push(bc);
			}
			optical = { spu: { udi: spu.udi, id: spu._id }, validationRunSteps: runSteps };
			cartFilter = barcodes.length ? { _id: { $in: [...new Set(barcodes)] } } : null;
			if (!cartFilter) optical.cartridges = [];
		} else if (modality !== 'all') {
			// Pure optical ask with no reference: recent optical cartridges.
			cartFilter = { ...OPTICAL_CARTRIDGE_FILTER };
		}

		if (cartFilter) {
			if (from || to) {
				const range: Record<string, Date> = {};
				if (from) range.$gte = from;
				if (to) range.$lte = to;
				cartFilter.createdAt = range;
			}
			const carts = await CartridgeRecord.find(cartFilter)
				.select('serialNumber assayId assayName assayCategory status statusUpdatedOn createdAt device rawData')
				.sort({ createdAt: -1 })
				.limit(limit)
				.lean();
			optical = {
				...(optical ?? {}),
				...(groupInfo ? { group: groupInfo } : {}),
				cartridges: (carts as any[]).map((c) => {
					const analysis = analyzeCartridge(c.rawData?.readings ?? []);
					return {
						source: 'cartridge_records (Optical Test Cartridge Log)',
						barcode: c._id,
						serialNumber: c.serialNumber ?? null,
						assayId: c.assayId ?? null,
						assayName: c.assayName ?? null,
						status: c.status ?? null,
						createdAt: c.createdAt ?? null,
						statusUpdatedOn: c.statusUpdatedOn ?? null,
						device: c.device ?? null,
						hasReadings: Array.isArray(c.rawData?.readings) && c.rawData.readings.length > 0,
						ratioByChannel: analysis?.ratioByChannel ?? null,
						crossWellCv: analysis?.crossWellCv ?? null,
						warning: analysis?.warning ?? null,
						warningReasons: analysis?.reasons ?? [],
						channelStats: (analysis?.channels ?? []).map((ch) => ({
							channel: ch.channel,
							n: ch.n,
							ratio: ch.ratio,
							ratioCv: ch.ratioCv,
							flags: ch.flags
						}))
					};
				})
			};
		} else if (!optical) {
			optical = { cartridges: [] };
		}
	}

	return json({
		success: true,
		data: {
			modality,
			spu: spu ? { id: spu._id, udi: spu.udi, barcode: spu.barcode ?? null } : null,
			validationSessions: sessions,
			optical,
			guidance:
				'Results come from multiple BIMS tabs: validation_sessions (magnetometer=mag, thermocouple=thermo, ' +
				'spectrophotometer) and the Optical Test Cartridge Log (cartridge_records analyzed on read). ' +
				'The legacy test_results collection is empty and is not consulted.'
		}
	});
};
