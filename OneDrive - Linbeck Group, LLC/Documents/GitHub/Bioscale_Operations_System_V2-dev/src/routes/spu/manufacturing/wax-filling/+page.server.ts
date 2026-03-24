import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable, ManufacturingSettings, generateId
} from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

/** Map DB status → UI stage string (STAGES const in svelte) */
function toStage(status: string | null | undefined): string | null {
	if (!status) return null;
	const map: Record<string, string> = {
		setup: 'Setup', Setup: 'Setup',
		loading: 'Loading', Loading: 'Loading',
		running: 'Running', Running: 'Running',
		awaiting_removal: 'Awaiting Removal', 'Awaiting Removal': 'Awaiting Removal',
		cooling: 'Awaiting Removal',
		qc: 'QC', QC: 'QC',
		storage: 'Storage', Storage: 'Storage'
	};
	return map[status] ?? null;
}

const ACTIVE_STAGES = new Set(['Setup', 'Loading', 'Running', 'Awaiting Removal', 'QC', 'Storage',
	'setup', 'loading', 'running', 'awaiting_removal', 'cooling', 'qc', 'storage']);

export const load: PageServerLoad = async ({ locals, url, parent }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Get robotId from URL param or first robot from layout
	const layoutData = await parent();
	const robotIdParam = url.searchParams.get('robot');
	const robotId = robotIdParam ?? layoutData.robots[0]?.robotId ?? '';

	if (!robotId) {
		return {
			robotId: '',
			loadError: 'No robots configured. Add a robot in equipment settings.',
			robotBlocked: null,
			runState: { hasActiveRun: false, runId: null, stage: null, runStartTime: null, runEndTime: null, deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null },
			settings: { runDurationMin: 45, removeDeckWarningMin: 5, coolingWarningMin: 30, deckLockoutMin: 60, incubatorTempC: 37, heaterTempC: 65 },
			tubeData: null, ovenLots: [], rejectionCodes: [], qcCartridges: [], storageCartridges: []
		};
	}

	// Load everything in parallel
	const [activeWaxRun, settingsDoc, activeTube, activeReagentRunRaw] = await Promise.all([
		WaxFillingRun.findOne({ 'robot._id': robotId, status: { $in: [...ACTIVE_STAGES] } })
			.sort({ createdAt: -1 }).lean(),
		ManufacturingSettings.findById('default').lean(),
		Consumable.findOne({ type: 'incubator_tube', status: 'active' }).lean(),
		// Check if a reagent run is active on this robot
		(async () => {
			try {
				const mongoose = (await import('mongoose')).default;
				const db = mongoose.connection.db;
				if (!db) return null;
				const cols = await db.listCollections({ name: 'reagent_filling_runs' }).toArray();
				if (!cols.length) return null;
				return db.collection('reagent_filling_runs').findOne({
					'robot._id': robotId,
					status: { $nin: ['completed', 'aborted', 'cancelled', 'Completed', 'Aborted', 'Cancelled'] }
				});
			} catch { return null; }
		})()
	]);

	const wax = (settingsDoc as any)?.waxFilling ?? {};
	const rejectionCodes = ((settingsDoc as any)?.rejectionReasonCodes ?? [])
		.filter((r: any) => !r.processType || r.processType === 'wax')
		.map((r: any, i: number) => ({
			id: r._id ?? String(i), code: r.code ?? '', label: r.label ?? '',
			processType: r.processType ?? 'wax', sortOrder: r.sortOrder ?? i
		}));

	const run = activeWaxRun as any;
	const stage = run ? toStage(run.status) : null;

	// Build runState
	const runState = run
		? {
			hasActiveRun: true,
			runId: String(run._id),
			stage,
			runStartTime: run.runStartTime ? new Date(run.runStartTime).toISOString() : null,
			runEndTime: run.runEndTime ? new Date(run.runEndTime).toISOString() : null,
			deckId: run.deckId ?? null,
			waxSourceLot: run.waxSourceLot ?? null,
			coolingTrayId: run.coolingTrayId ?? null,
			plannedCartridgeCount: run.plannedCartridgeCount ?? run.cartridgeIds?.length ?? null
		}
		: { hasActiveRun: false, runId: null, stage: null, runStartTime: null, runEndTime: null, deckId: null, waxSourceLot: null, coolingTrayId: null, plannedCartridgeCount: null };

	// Tube data
	const tube = activeTube as any;
	const tubeData = tube
		? {
			tubeId: String(tube._id),
			initialVolumeUl: tube.initialVolumeUl ?? 0,
			remainingVolumeUl: tube.remainingVolumeUl ?? 0,
			status: tube.status ?? 'active',
			totalCartridgesFilled: tube.totalCartridgesFilled ?? 0,
			totalRunsUsed: tube.totalRunsUsed ?? 0
		}
		: null;

	// QC cartridges (wax_filled phase, for this robot's run)
	const qcCartridgesRaw = run
		? await CartridgeRecord.find({ 'waxFilling.runId': String(run._id) }).lean()
		: [];

	const qcCartridges = (qcCartridgesRaw as any[]).map((c: any) => ({
		cartridgeId: String(c._id),
		backedLotId: c.backing?.lotId ?? '',
		ovenEntryTime: c.backing?.ovenEntryTime ? new Date(c.backing.ovenEntryTime).toISOString() : null,
		waxRunId: c.waxFilling?.runId ?? null,
		deckPosition: c.waxFilling?.deckPosition ?? null,
		waxTubeId: c.waxFilling?.waxTubeId ?? null,
		coolingTrayId: c.waxStorage?.coolingTrayId ?? null,
		transferTimeSeconds: c.waxFilling?.transferTimeSeconds ?? null,
		qcStatus: c.waxQc?.status ?? 'Pending',
		rejectionReason: c.waxQc?.rejectionReason ?? null,
		qcTimestamp: c.waxQc?.timestamp ? new Date(c.waxQc.timestamp).toISOString() : null,
		currentInventory: c.currentPhase ?? 'wax_filled',
		storageLocation: c.waxStorage?.location ?? null,
		storageTimestamp: c.waxStorage?.timestamp ? new Date(c.waxStorage.timestamp).toISOString() : null,
		storageOperatorId: c.waxStorage?.operator?._id ?? null,
		createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : '',
		updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : ''
	}));

	// Storage cartridges (wax_stored phase)
	const storageCartridgesRaw = run
		? await CartridgeRecord.find({ 'waxFilling.runId': String(run._id), currentPhase: 'wax_stored' }).lean()
		: [];

	const storageCartridges = (storageCartridgesRaw as any[]).map((c: any) => ({
		cartridgeId: String(c._id),
		qcStatus: c.waxQc?.status ?? 'Accepted',
		currentInventory: c.currentPhase ?? 'wax_stored',
		storageLocation: c.waxStorage?.location ?? null
	}));

	// Oven lots (completed runs with ovenLocationId set)
	const ovenRunsRaw = await WaxFillingRun.find({
		'robot._id': robotId,
		status: { $in: ['completed', 'storage', 'Storage'] },
		ovenLocationId: { $exists: true, $ne: null }
	}).sort({ runEndTime: -1 }).limit(20).lean();

	const minOvenTimeMin = wax.minOvenTimeMin ?? 60;
	const now = Date.now();
	const ovenLots = (ovenRunsRaw as any[]).map((r: any) => {
		const endTime = r.runEndTime ? new Date(r.runEndTime).getTime() : 0;
		const elapsedMin = endTime ? (now - endTime) / 60000 : 0;
		return { lotId: String(r._id), ready: elapsedMin >= minOvenTimeMin };
	});

	// Check if robot is blocked by reagent filling
	const robotBlocked = activeReagentRunRaw
		? { process: 'reagent' as const, runId: activeReagentRunRaw._id ? String(activeReagentRunRaw._id) : null }
		: null;

	return {
		robotId,
		loadError: null,
		robotBlocked,
		runState,
		settings: {
			runDurationMin: wax.runDurationMin ?? 45,
			removeDeckWarningMin: wax.removeDeckWarningMin ?? 5,
			coolingWarningMin: wax.coolingWarningMin ?? 30,
			deckLockoutMin: wax.deckLockoutMin ?? 60,
			incubatorTempC: wax.incubatorTempC ?? 37,
			heaterTempC: wax.heaterTempC ?? 65
		},
		tubeData,
		ovenLots,
		rejectionCodes,
		qcCartridges,
		storageCartridges
	};
};

export const actions: Actions = {
	/** Confirm setup — create a new run or re-confirm existing setup */
	confirmSetup: async ({ request, locals, url }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = (data.get('robotId') as string) ?? url.searchParams.get('robot') ?? '';
		const robotName = (data.get('robotName') as string) ?? '';
		const deckId = (data.get('deckId') as string) || undefined;
		const waxSourceLot = (data.get('waxSourceLot') as string) || undefined;

		// Validate deck if provided
		if (deckId) {
			const deck = await Consumable.findOne({ _id: deckId, type: 'deck' }).lean();
			if (!deck) return fail(400, { error: `Deck '${deckId}' not found. Register it in Consumables first.` });
			if ((deck as any).status === 'retired') return fail(400, { error: `Deck '${deckId}' is retired and cannot be used.` });
		}

		// Check for existing active run
		const existingRun = await WaxFillingRun.findOne({
			'robot._id': robotId,
			status: { $in: [...ACTIVE_STAGES] }
		}).lean() as any;

		if (existingRun) {
			// Transition existing setup run to Loading
			if (existingRun.status === 'setup' || existingRun.status === 'Setup') {
				await WaxFillingRun.findByIdAndUpdate(existingRun._id, {
					$set: { status: 'Loading', deckId: deckId ?? existingRun.deckId, waxSourceLot: waxSourceLot ?? existingRun.waxSourceLot }
				});
			}
			return { success: true, runId: String(existingRun._id) };
		}

		const run = await WaxFillingRun.create({
			robot: { _id: robotId, name: robotName },
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'Loading',
			cartridgeIds: [],
			deckId,
			waxSourceLot,
			setupTimestamp: new Date()
		});

		return { success: true, runId: String(run._id) };
	},

	/** Record wax preparation (tube info) */
	recordWaxPrep: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const waxTubeId = (data.get('waxTubeId') as string) || undefined;
		const waxSourceLot = (data.get('waxSourceLot') as string) || undefined;
		const plannedCartridgeCount = data.get('plannedCartridgeCount') ? Number(data.get('plannedCartridgeCount')) : undefined;

		const update: Record<string, any> = { status: 'Loading' };
		if (waxTubeId) update.waxTubeId = waxTubeId;
		if (waxSourceLot) update.waxSourceLot = waxSourceLot;
		if (plannedCartridgeCount) update.plannedCartridgeCount = plannedCartridgeCount;

		await WaxFillingRun.findByIdAndUpdate(runId, { $set: update });
		return { success: true };
	},

	/** Load deck — add cartridges to run */
	loadDeck: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const deckId = (data.get('deckId') as string) || undefined;
		const cartridgeScansRaw = data.get('cartridgeScans') as string;

		let cartridgeIds: string[] = [];
		if (cartridgeScansRaw) {
			try {
				cartridgeIds = JSON.parse(cartridgeScansRaw);
			} catch {
				return fail(400, { error: 'Invalid cartridge scan data' });
			}
		}

		// Validate deck if provided
		if (deckId) {
			const deck = await Consumable.findOne({ _id: deckId, type: 'deck' }).lean();
			if (!deck) return fail(400, { error: `Deck '${deckId}' not found. Register it in Consumables first.` });
			if ((deck as any).status === 'retired') return fail(400, { error: `Deck '${deckId}' is retired.` });
		}

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Create CartridgeRecord stubs for each cartridge
		if (cartridgeIds.length > 0) {
			const ops = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid },
					update: {
						$setOnInsert: {
							_id: cid,
							currentPhase: 'backing',
							'backing.recordedAt': new Date()
						}
					},
					upsert: true
				}
			}));
			await CartridgeRecord.bulkWrite(ops);
		}

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: {
				status: 'Loading',
				deckId: deckId ?? run.deckId,
				plannedCartridgeCount: cartridgeIds.length || run.plannedCartridgeCount
			},
			$addToSet: { cartridgeIds: { $each: cartridgeIds } }
		});

		return { success: true };
	},

	/** Start the robot run */
	startRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Running', runStartTime: new Date() }
		});
		return { success: true };
	},

	/** Confirm deck removed — transition Running → Awaiting Removal */
	confirmDeckRemoved: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Awaiting Removal', deckRemovedTime: new Date() }
		});
		return { success: true };
	},

	/** Confirm cooling — transition Awaiting Removal → QC */
	confirmCooling: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;

		const update: Record<string, any> = { status: 'QC', coolingConfirmedTime: new Date() };
		if (coolingTrayId) update.coolingTrayId = coolingTrayId;

		await WaxFillingRun.findByIdAndUpdate(runId, { $set: update });
		return { success: true };
	},

	/** Complete QC — inspect all cartridges and transition to Storage */
	completeQC: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Storage', runEndTime: now }
		}, { new: true }).lean() as any;

		// Write waxFilling phase to all cartridges (WRITE-ONCE)
		if (run?.cartridgeIds?.length) {
			const bulkOps = run.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxFilling.recordedAt': { $exists: false } },
					update: {
						$set: {
							'waxFilling.runId': run._id,
							'waxFilling.robotId': run.robot?._id,
							'waxFilling.robotName': run.robot?.name,
							'waxFilling.deckId': run.deckId,
							'waxFilling.waxTubeId': run.waxTubeId,
							'waxFilling.waxSourceLot': run.waxSourceLot,
							'waxFilling.operator': run.operator,
							'waxFilling.runStartTime': run.runStartTime,
							'waxFilling.runEndTime': now,
							'waxFilling.recordedAt': now,
							currentPhase: 'wax_filled'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true };
	},

	/** Cancel / abort an active run */
	cancelRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Cancelled by operator';

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: new Date() }
		});
		return { success: true };
	},

	abortRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = (data.get('reason') as string) || 'Aborted';

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: new Date() }
		});
		return { success: true };
	},

	/** Reject a cartridge during QC */
	rejectCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const rejectionReason = (data.get('rejectionReason') as string) || '';
		const now = new Date();

		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'waxQc.recordedAt': { $exists: false } },
			{
				$set: {
					'waxQc.status': 'Rejected',
					'waxQc.rejectionReason': rejectionReason,
					'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
					'waxQc.timestamp': now,
					'waxQc.recordedAt': now,
					currentPhase: 'voided'
				}
			}
		);
		return { success: true };
	},

	/** Record storage location for cartridges */
	recordBatchStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;
		const location = data.get('location') as string;
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;

		let cartridgeIds: string[] = [];
		try {
			cartridgeIds = JSON.parse(cartridgeIdsRaw);
		} catch {
			return fail(400, { error: 'Invalid cartridge IDs' });
		}

		const now = new Date();
		if (cartridgeIds.length > 0) {
			const bulkOps = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxStorage.recordedAt': { $exists: false } },
					update: {
						$set: {
							'waxStorage.location': location,
							'waxStorage.coolingTrayId': coolingTrayId,
							'waxStorage.operator': { _id: locals.user._id, username: locals.user.username },
							'waxStorage.timestamp': now,
							'waxStorage.recordedAt': now,
							currentPhase: 'wax_stored'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		return { success: true };
	},

	/** Complete the full run */
	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'completed', runEndTime: now }
		}, { new: true }).lean() as any;

		// Update consumable usage logs
		const cartridgeCount = run?.cartridgeIds?.length ?? 0;
		const operatorRef = { _id: locals.user._id, username: locals.user.username };

		if (run?.deckId) {
			await Consumable.findByIdAndUpdate(run.deckId, {
				$set: { lastUsed: now },
				$push: {
					usageLog: {
						_id: generateId(), usageType: 'run_complete', runId: run._id,
						quantityChanged: cartridgeCount, operator: operatorRef,
						notes: `Wax filling run complete — ${cartridgeCount} cartridges filled`, createdAt: now
					}
				}
			});
		}

		if (run?.waxTubeId) {
			await Consumable.findByIdAndUpdate(run.waxTubeId, {
				$set: { lastUsedAt: now },
				$inc: { totalCartridgesFilled: cartridgeCount, totalRunsUsed: 1 },
				$push: {
					usageLog: {
						_id: generateId(), usageType: 'wax_run', runId: run._id,
						quantityChanged: cartridgeCount, operator: operatorRef,
						notes: `Wax filling run complete — ${cartridgeCount} cartridges`, createdAt: now
					}
				}
			});
		}

		return { success: true };
	}
};
