import { redirect, fail } from '@sveltejs/kit';
import { connectDB, WaxFillingRun, CartridgeRecord, AssayDefinition, Consumable, ManufacturingSettings, generateId } from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [runs, assayTypes] = await Promise.all([
		WaxFillingRun.find().sort({ createdAt: -1 }).limit(50).lean(),
		AssayDefinition.find({ isActive: true }, { _id: 1, name: 1, skuCode: 1 }).lean()
	]);

	return {
		runs: runs.map((r: any) => ({
			id: r._id,
			robotId: r.robot?._id ?? null,
			robotName: r.robot?.name ?? null,
			status: r.status ?? null,
			stage: r.status ?? null,
			assayTypeId: null,
			assayTypeName: null,
			cartridgeCount: r.cartridgeIds?.length ?? 0,
			startTime: r.runStartTime ?? null,
			endTime: r.runEndTime ?? null,
			createdAt: r.createdAt
		})),
		assayTypes: assayTypes.map((a: any) => ({
			id: a._id, name: a.name, skuCode: a.skuCode ?? null
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const robotId = data.get('robotId') as string;
		const robotName = data.get('robotName') as string;
		const deckId = (data.get('deckId') as string) || undefined;

		// FIX-05: Validate deckId if provided
		if (deckId) {
			const deck = await Consumable.findOne({ _id: deckId, type: 'deck' }).lean();
			if (!deck) return fail(400, { error: `Deck '${deckId}' not found. Register it in Consumables first.` });
			if ((deck as any).status === 'retired') return fail(400, { error: `Deck '${deckId}' is retired and cannot be used.` });
		}

		const run = await WaxFillingRun.create({
			robot: { _id: robotId, name: robotName },
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'setup',
			cartridgeIds: [],
			deckId,
			setupTimestamp: new Date()
		});

		return { success: true, runId: run._id };
	},

	start: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'running', runStartTime: new Date() }
		});
		return { success: true };
	},

	complete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'completed', runEndTime: now }
		}, { new: true }).lean() as any;

		// Update cartridge records — write waxFilling phase (WRITE-ONCE)
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

		// FIX-05: Update Consumable usage logs for deck and tube used in this run
		const cartridgeCount = run?.cartridgeIds?.length ?? 0;
		const operatorRef = { _id: locals.user._id, username: locals.user.username };

		if (run?.deckId) {
			await Consumable.findByIdAndUpdate(run.deckId, {
				$set: { lastUsed: now },
				$push: {
					usageLog: {
						_id: generateId(),
						usageType: 'run_complete',
						runId: run._id,
						quantityChanged: cartridgeCount,
						operator: operatorRef,
						notes: `Wax filling run complete — ${cartridgeCount} cartridges filled`,
						createdAt: now
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
						_id: generateId(),
						usageType: 'wax_run',
						runId: run._id,
						quantityChanged: cartridgeCount,
						operator: operatorRef,
						notes: `Wax filling run complete — ${cartridgeCount} cartridges`,
						createdAt: now
					}
				}
			});
		}

		return { success: true };
	},

	abort: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const reason = data.get('reason') as string;

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'aborted', abortReason: reason, runEndTime: new Date() }
		});
		return { success: true };
	},

	addCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeId = data.get('cartridgeId') as string;
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;

		// FIX-05: Validate cooling tray if provided
		if (coolingTrayId) {
			const tray = await Consumable.findOne({ _id: coolingTrayId, type: 'cooling_tray' }).lean();
			if (!tray) return fail(400, { error: `Cooling tray '${coolingTrayId}' not found. Register it in Consumables first.` });
			if ((tray as any).status === 'retired') return fail(400, { error: `Cooling tray '${coolingTrayId}' is retired.` });
		}

		// Create CartridgeRecord if it doesn't exist (backing phase)
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId },
			{
				$setOnInsert: {
					_id: cartridgeId,
					currentPhase: 'backing',
					'backing.recordedAt': new Date()
				}
			},
			{ upsert: true }
		);

		await WaxFillingRun.findByIdAndUpdate(runId, {
			$addToSet: { cartridgeIds: cartridgeId }
		});

		return { success: true };
	},

	waxQcInspect: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const status = data.get('status') as string; // 'Accepted' | 'Rejected'
		const rejectionReason = data.get('rejectionReason') as string;

		// WRITE-ONCE: only write if waxQc.recordedAt doesn't exist
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'waxQc.recordedAt': { $exists: false } },
			{
				$set: {
					'waxQc.status': status,
					'waxQc.rejectionReason': rejectionReason || undefined,
					'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
					'waxQc.timestamp': new Date(),
					'waxQc.recordedAt': new Date(),
					currentPhase: status === 'Accepted' ? 'wax_qc' : 'voided'
				}
			}
		);

		return { success: true };
	},

	waxStore: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeId = data.get('cartridgeId') as string;
		const location = data.get('location') as string;
		const coolingTrayId = data.get('coolingTrayId') as string;

		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'waxStorage.recordedAt': { $exists: false } },
			{
				$set: {
					'waxStorage.location': location,
					'waxStorage.coolingTrayId': coolingTrayId || undefined,
					'waxStorage.operator': { _id: locals.user._id, username: locals.user.username },
					'waxStorage.timestamp': new Date(),
					'waxStorage.recordedAt': new Date(),
					currentPhase: 'wax_stored'
				}
			}
		);

		return { success: true };
	}
};
