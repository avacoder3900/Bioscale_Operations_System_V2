/**
 * Diluent wizard load (DILUENT-FILL-1, 2026-11-13). Same contract as
 * loadReagentWizard: the Robots page calls it once per robot whose diluent
 * panel is open, the diluent-filling setup page calls it for ?robot=. The
 * actions live on the diluent-filling route.
 */
import { redirect } from '@sveltejs/kit';
import {
	connectDB, DiluentFillRun, DiluentLot, ReagentLot, OpentronsRobot, WaxFillingRun, ReagentBatchRecord
} from '$lib/server/db';
import { WAX_PAGE_OWNED, REAGENT_PAGE_OWNED, DILUENT_PAGE_OWNED } from './run-statuses';
import { getRobot, robotGet } from '$lib/server/opentrons/proxy';
import { requirePermission } from '$lib/server/permissions';
import { finalizeDiluentRun, reconcileStartIntent, setRunRecordStatus } from '$lib/server/opentrons/run-lifecycle-records';
import {
	DILUENT_DEFAULT_VOLUME_UL,
	DILUENT_PIPETTES,
	DILUENT_SOURCE_WELLS,
	DILUENT_TUBES_PER_RACK,
	type DiluentPipette
} from '$lib/manufacturing/diluent-fill';

export interface DiluentLotOption {
	id: string;
	lotBarcode: string;
	templateName: string | null;
	finalizedAt: string | null;
	operator: string | null;
	volume: number | null;
	volumeUnit: string | null;
}

export interface DiluentWizardRun {
	runId: string;
	stage: 'Setup' | 'Loading' | 'Running';
	pipette: DiluentPipette;
	diluentVolumeUl: number;
	tubesPerTrip: number;
	sources: { well: string; reagentLotId: string | null; reagentLotBarcode: string | null; templateName: string | null; tubesPlanned: number; loadedMl: number; tubesFilled: number | null }[];
	deckConfirmed: boolean;
	runStartTime: string | null;
	runEndTime: string | null;
	opentronsRunId: string | null;
	opentronsRunFinalStatus: string | null;
	protocolParameters: Record<string, unknown> | null;
	startInterrupted: string | null;
	diluentLotNumber: string | null;
}

export interface RecentDiluentLot {
	lotNumber: string;
	tubesTotal: number;
	volumeUl: number;
	finishedAt: string;
}

const iso = (d: unknown): string | null => (d ? new Date(d as string).toISOString() : null);

function emptyState(robotId: string, loadError: string | null = null) {
	return {
		robotId,
		activeRunId: null as string | null,
		robotBlocked: null as { process: 'wax' | 'reagent'; runId: string | null } | null,
		loadError,
		run: null as DiluentWizardRun | null,
		reagentLots: [] as DiluentLotOption[],
		robotProtocols: [] as Array<{ opentronsProtocolId: string; protocolName: string; protocolType: string | null; analysisStatus: string | null; parametersSchema: any }>,
		opentronsRobotId: robotId,
		defaults: { pipette: 'p1000' as DiluentPipette, volumeUl: DILUENT_DEFAULT_VOLUME_UL, tubesPerRack: DILUENT_TUBES_PER_RACK, tubesPerTrip: DILUENT_PIPETTES.p1000.maxTubesPerTrip },
		lastTipState: null as null | { nextTipIndex: number | null; hostname: string | null; capturedAt: string | null },
		recentLot: null as RecentDiluentLot | null
	};
}

export async function loadDiluentWizard(locals: App.Locals, robotId: string) {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'diluentFilling:read');
	const user = { _id: locals.user._id, username: locals.user.username };

	try {
		await connectDB();

		let activeRun: any = robotId
			? await DiluentFillRun.findOne({ 'robot._id': robotId, status: { $in: [...DILUENT_PAGE_OWNED] } }).sort({ createdAt: -1 }).lean().catch(() => null)
			: null;

		// Two-phase start: settle an interrupted start (confirm its robot run, or clear it).
		let startInterrupted: string | null = null;
		if (activeRun?.startIntent?.token) {
			const rec = await reconcileStartIntent('diluent', activeRun, user);
			startInterrupted = rec.banner;
			if (rec.changed) activeRun = await DiluentFillRun.findById(activeRun._id).lean().catch(() => activeRun);
		}

		// Self-heal: a run that finished while no tab was open is finalized on the next visit.
		if (activeRun && activeRun.status === 'Running') {
			try {
				let final = String(activeRun.opentronsRunFinalStatus ?? '').toLowerCase();
				if (!final && activeRun.opentronsRunId) {
					const rRobot = await getRobot(activeRun.robot?._id);
					if (rRobot) {
						const rs = await robotGet(rRobot, `/runs/${activeRun.opentronsRunId}`);
						if (rs.ok) final = String(((await rs.json())?.data?.status ?? '')).toLowerCase();
					}
					if (final === 'succeeded') {
						await DiluentFillRun.findByIdAndUpdate(activeRun._id, { $set: { opentronsRunFinalStatus: final } });
					}
				}
				if (final === 'succeeded') {
					await finalizeDiluentRun(String(activeRun._id), user, 'auto (load reconcile)');
					await setRunRecordStatus(String(activeRun._id), activeRun.opentronsRunId, 'succeeded');
					activeRun = null;
				}
			} catch (e) {
				console.error('[diluent load] run reconcile failed:', e instanceof Error ? e.message : e);
			}
		}

		const [robotDoc, lastTipRun, finalizedLots, waxRun, reagentRun, lastLot] = await Promise.all([
			robotId ? OpentronsRobot.findById(robotId).lean().catch(() => null) : Promise.resolve(null),
			robotId
				? DiluentFillRun.findOne({ 'robot._id': robotId, 'pipetteTipState.after.nextTipIndex': { $exists: true } })
						.sort({ runEndTime: -1 }).select('pipetteTipState').lean().catch(() => null)
				: Promise.resolve(null),
			ReagentLot.find({ status: 'finalized' })
				.select('_id lotBarcode templateName finalizedAt operator finalOutputs')
				.sort({ finalizedAt: -1 })
				.limit(100)
				.lean()
				.catch(() => []),
			robotId ? WaxFillingRun.findOne({ 'robot._id': robotId, status: { $in: WAX_PAGE_OWNED } }).select('_id').lean().catch(() => null) : Promise.resolve(null),
			robotId ? ReagentBatchRecord.findOne({ 'robot._id': robotId, status: { $in: REAGENT_PAGE_OWNED } }).select('_id').lean().catch(() => null) : Promise.resolve(null),
			robotId
				? DiluentLot.findOne({ 'robot._id': robotId, createdAt: { $gte: new Date(Date.now() - 4 * 3_600_000) } })
						.sort({ createdAt: -1 }).lean().catch(() => null)
				: Promise.resolve(null)
		]);

		const robotProtocols = ((robotDoc as any)?.protocols ?? [])
			.map((p: any) => ({
				opentronsProtocolId: p.opentronsProtocolId ?? null,
				protocolName: p.protocolName ?? '',
				protocolType: p.protocolType ?? null,
				analysisStatus: p.analysisStatus ?? null,
				parametersSchema: p.parametersSchema ?? null
			}))
			// Only the diluent protocol may start from this wizard.
			.filter((p: any) => p.opentronsProtocolId && p.protocolType === 'diluent-filling');

		const reagentLots: DiluentLotOption[] = (finalizedLots as any[]).map((l) => ({
			id: String(l._id),
			lotBarcode: String(l.lotBarcode ?? ''),
			templateName: l.templateName ?? null,
			finalizedAt: iso(l.finalizedAt),
			operator: l.operator?.username ?? null,
			volume: l.finalOutputs?.volume ?? null,
			volumeUnit: l.finalOutputs?.volumeUnit ?? null
		}));

		const run: DiluentWizardRun | null = activeRun
			? {
					runId: String(activeRun._id),
					stage: activeRun.status,
					pipette: activeRun.pipette ?? 'p1000',
					diluentVolumeUl: Number(activeRun.diluentVolumeUl ?? DILUENT_DEFAULT_VOLUME_UL),
					tubesPerTrip: Number(activeRun.tubesPerTrip ?? DILUENT_PIPETTES[(activeRun.pipette ?? 'p1000') as DiluentPipette].maxTubesPerTrip),
					sources: DILUENT_SOURCE_WELLS.map((well) => {
						const s = ((activeRun.sources ?? []) as any[]).find((x) => x.well === well);
						return {
							well,
							reagentLotId: s?.reagentLotId ?? null,
							reagentLotBarcode: s?.reagentLotBarcode ?? null,
							templateName: s?.templateName ?? null,
							tubesPlanned: Number(s?.tubesPlanned ?? 0),
							loadedMl: Number(s?.loadedMl ?? 0),
							tubesFilled: s?.tubesFilled ?? null
						};
					}),
					deckConfirmed: !!activeRun.deckConfirmedAt,
					runStartTime: iso(activeRun.runStartTime),
					runEndTime: iso(activeRun.runEndTime),
					opentronsRunId: activeRun.opentronsRunId ?? null,
					opentronsRunFinalStatus: activeRun.opentronsRunFinalStatus ?? null,
					protocolParameters: activeRun.protocolParameters ?? null,
					startInterrupted,
					diluentLotNumber: activeRun.diluentLotNumber ?? null
				}
			: null;

		const robotBlocked = waxRun
			? { process: 'wax' as const, runId: String((waxRun as any)._id) }
			: reagentRun
				? { process: 'reagent' as const, runId: String((reagentRun as any)._id) }
				: null;

		return {
			...emptyState(robotId),
			activeRunId: run?.runId ?? null,
			robotBlocked,
			run,
			reagentLots,
			robotProtocols,
			lastTipState: (lastTipRun as any)?.pipetteTipState?.after
				? {
						nextTipIndex: (lastTipRun as any).pipetteTipState.after.nextTipIndex ?? null,
						hostname: (lastTipRun as any).pipetteTipState.after.hostname ?? null,
						capturedAt: iso((lastTipRun as any).pipetteTipState.after.capturedAt)
					}
				: null,
			recentLot: lastLot
				? {
						lotNumber: String((lastLot as any).lotNumber),
						tubesTotal: Number((lastLot as any).tubesTotal ?? 0),
						volumeUl: Number((lastLot as any).volumeUl ?? 0),
						finishedAt: iso((lastLot as any).createdAt) ?? new Date().toISOString()
					}
				: null
		};
	} catch (err) {
		console.error('[DILUENT-FILLING PAGE] Load error:', err instanceof Error ? err.message : err);
		return emptyState(robotId, 'Failed to load diluent filling data. Please refresh the page.');
	}
}

export type DiluentWizardData = Awaited<ReturnType<typeof loadDiluentWizard>>;
