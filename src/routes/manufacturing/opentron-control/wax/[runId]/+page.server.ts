/**
 * Opentron Control — Wax post-OT-2 flow (steps 4-6: cooling, QC, storage).
 *
 * Actions here are functionally identical to the ones in wax-filling/+page.server.ts.
 * They're duplicated rather than shared via module because SvelteKit actions
 * must be defined on their own route, and extracting to a shared service is a
 * future refactor. If you fix a bug in one, fix it in the other too.
 */
import { redirect, fail, error } from '@sveltejs/kit';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable,
	ManufacturingSettings, generateId, Equipment, EquipmentLocation,
	AuditLog, ReceivingLot
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { notifyRunLifecycle } from '$lib/server/notifications';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

const WAX_FILL_VOLUME_UL = 800;

function toStage(status: string | null | undefined): string | null {
	if (!status) return null;
	const map: Record<string, string> = {
		'Awaiting Removal': 'Awaiting Removal', awaiting_removal: 'Awaiting Removal',
		cooling: 'Awaiting Removal',
		QC: 'QC', qc: 'QC',
		Storage: 'Storage', storage: 'Storage',
		completed: 'Storage'
	};
	return map[status] ?? null;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const run = await WaxFillingRun.findById(params.runId).lean() as any;
	if (!run) throw error(404, 'Wax run not found');
	if (!run.robotReleasedAt) throw error(400, 'This run is still on the OT-2 — access it from the Wax Filling page');

	const stage = toStage(run.status);
	const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
	const wax = settingsDoc?.waxFilling ?? {};

	const rejectionCodes = (settingsDoc?.rejectionReasonCodes ?? [])
		.filter((r: any) => !r.processType || r.processType === 'wax')
		.map((r: any, i: number) => ({
			id: r._id ? String(r._id) : String(i), code: r.code ?? '', label: r.label ?? '',
			processType: r.processType ?? 'wax', sortOrder: r.sortOrder ?? i
		}));

	const cartridgesRaw = run.cartridgeIds?.length
		? await CartridgeRecord.find({ _id: { $in: run.cartridgeIds } }).lean().catch(() => [])
		: [];

	const qcCartridges = (cartridgesRaw as any[]).map((c: any) => ({
		cartridgeId: String(c._id),
		backedLotId: c.backing?.lotId ?? '',
		ovenEntryTime: c.backing?.ovenEntryTime ? new Date(c.backing.ovenEntryTime).toISOString() : null,
		waxRunId: c.waxFilling?.runId ? String(c.waxFilling.runId) : null,
		deckPosition: c.waxFilling?.deckPosition ?? null,
		waxTubeId: c.waxFilling?.waxTubeId ?? null,
		coolingTrayId: c.waxStorage?.coolingTrayId ?? null,
		transferTimeSeconds: c.waxFilling?.transferTimeSeconds ?? null,
		qcStatus: c.waxQc?.status ?? 'Pending',
		rejectionReason: c.waxQc?.rejectionReason ?? null,
		qcTimestamp: c.waxQc?.timestamp ? new Date(c.waxQc.timestamp).toISOString() : null,
		currentInventory: c.status ?? 'wax_filled',
		storageLocation: c.waxStorage?.location ?? null,
		storageTimestamp: c.waxStorage?.timestamp ? new Date(c.waxStorage.timestamp).toISOString() : null,
		storageOperatorId: c.waxStorage?.operator?._id ? String(c.waxStorage.operator._id) : null,
		createdAt: c.createdAt ? new Date(c.createdAt).toISOString() : '',
		updatedAt: c.updatedAt ? new Date(c.updatedAt).toISOString() : ''
	}));

	const storageCartridges = (cartridgesRaw as any[]).map((c: any) => ({
		cartridgeId: String(c._id),
		qcStatus: c.waxQc?.status ?? 'Accepted',
		currentInventory: c.status ?? 'wax_stored',
		storageLocation: c.waxStorage?.location ?? null
	}));

	const [equipFridges, orphanFridges] = await Promise.all([
		Equipment.find({ equipmentType: 'fridge', status: { $ne: 'offline' } }).lean().catch(() => []),
		EquipmentLocation.find({ locationType: 'fridge', isActive: true, parentEquipmentId: { $exists: false } }).lean().catch(() => [])
	]);
	const fridges = [
		...(equipFridges as any[]).map((f: any) => ({
			id: String(f._id), displayName: f.name ?? f.barcode ?? String(f._id), barcode: f.barcode ?? ''
		})),
		...(orphanFridges as any[]).map((f: any) => ({
			id: String(f._id), displayName: f.displayName ?? f.barcode ?? String(f._id), barcode: f.barcode ?? ''
		}))
	];

	return {
		runId: String(run._id),
		stage,
		runState: {
			hasActiveRun: true,
			runId: String(run._id),
			stage,
			runStartTime: run.runStartTime ? new Date(run.runStartTime).toISOString() : null,
			runEndTime: run.runEndTime ? new Date(run.runEndTime).toISOString() : null,
			deckRemovedTime: run.deckRemovedTime ? new Date(run.deckRemovedTime).toISOString() : null,
			deckId: run.deckId ?? null,
			waxSourceLot: run.waxSourceLot ?? null,
			coolingTrayId: run.coolingTrayId ?? null,
			plannedCartridgeCount: run.plannedCartridgeCount ?? run.cartridgeIds?.length ?? null,
			coolingConfirmedAt: run.coolingConfirmedTime ? new Date(run.coolingConfirmedTime).toISOString() : null
		},
		settings: {
			coolingWarningMin: wax.coolingWarningMin ?? 7,
			deckLockoutMin: wax.deckLockoutMin ?? 25
		},
		rejectionCodes,
		qcCartridges: JSON.parse(JSON.stringify(qcCartridges)),
		storageCartridges: JSON.parse(JSON.stringify(storageCartridges)),
		fridges: JSON.parse(JSON.stringify(fridges)),
		robotName: run.robot?.name
			|| (run.robot?._id
				? (await Equipment.findById(run.robot._id).select('name').lean() as any)?.name
				: null)
			|| ''
	};
};

export const actions: Actions = {
	/** Confirm cooling + record curing oven placement. Called when operator
	 *  finishes PostRunCooling and scans the curing oven barcode. Writes
	 *  ovenCure entry + exit on cartridges, advances run to QC. */
	confirmCooling: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;
		const ovenLocationId = (data.get('ovenLocationId') as string) || undefined;
		const ovenLocationName = (data.get('ovenLocationName') as string) || undefined;
		const now = new Date();

		const update: Record<string, any> = { status: 'QC', coolingConfirmedTime: now, coolingConfirmedAt: now };
		if (coolingTrayId) update.coolingTrayId = coolingTrayId;
		if (ovenLocationId) update.ovenLocationId = ovenLocationId;

		const run = await WaxFillingRun.findByIdAndUpdate(runId, { $set: update }, { new: true }).lean() as any;

		// Write curing oven entry + exit on cartridges (deck placed in oven = entry; cooling confirmed = exit)
		if (run?.cartridgeIds?.length) {
			const bulkOps = run.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'ovenCure.entryTime': { $exists: false } },
					update: {
						$set: {
							'ovenCure.locationId': ovenLocationId ?? undefined,
							'ovenCure.locationName': ovenLocationName ?? ovenLocationId ?? undefined,
							'ovenCure.entryTime': now,
							'ovenCure.exitTime': now,
							'ovenCure.operator': { _id: locals.user._id, username: locals.user.username },
							'ovenCure.recordedAt': now
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);
		}

		// Run has been released to the QC queue — send the operator back to the
		// Opentron Control homepage so they can start another run. QC + Storage
		// can be picked up later from the post-OT-2 queue.
		redirect(303, '/manufacturing/opentron-control');
	},

	completeQC: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const runBeforeQc = await WaxFillingRun.findById(runId).select('coolingConfirmedAt coolingConfirmedTime').lean() as any;
		const confirmedAt = runBeforeQc?.coolingConfirmedAt ?? runBeforeQc?.coolingConfirmedTime;
		if (confirmedAt) {
			const elapsedMs = Date.now() - new Date(confirmedAt).getTime();
			if (elapsedMs < 10 * 60 * 1000) {
				const remainingMin = Math.ceil((10 * 60 * 1000 - elapsedMs) / 60000);
				return fail(400, { error: `Cartridges must cool for at least 10 minutes. ${remainingMin} min remaining.` });
			}
		}

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Storage', runEndTime: now }
		}, { new: true }).lean() as any;

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
							status: 'wax_filled'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			const waxPartId = await resolvePartId('PT-CT-105');
			for (const cid of run.cartridgeIds) {
				await recordTransaction({
					transactionType: 'consumption',
					partDefinitionId: waxPartId ?? undefined,
					cartridgeRecordId: cid,
					lotId: run.waxSourceLot ?? undefined,
					quantity: 1,
					manufacturingStep: 'wax_filling',
					manufacturingRunId: String(run._id),
					operatorId: run.operator?._id,
					operatorUsername: run.operator?.username,
					notes: `Wax-filled cartridge created in run ${run._id}`
				});
			}
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'Storage' }
		});

		return { success: true };
	},

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
					status: 'voided'
				}
			}
		);

		await recordTransaction({
			transactionType: 'scrap',
			cartridgeRecordId: cartridgeId,
			quantity: 1,
			manufacturingStep: 'wax_filling',
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			scrapReason: rejectionReason,
			scrapCategory: 'wax_defect',
			notes: `Wax QC rejection: ${rejectionReason}`
		});

		return { success: true };
	},

	recordBatchStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;
		const location = data.get('storageLocation') as string;
		const coolingTrayId = (data.get('coolingTrayId') as string) || undefined;

		let cartridgeIds: string[] = [];
		try { cartridgeIds = JSON.parse(cartridgeIdsRaw); } catch {
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
							status: 'wax_stored'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			for (const cid of cartridgeIds) {
				await recordTransaction({
					transactionType: 'creation',
					cartridgeRecordId: cid,
					quantity: 1,
					manufacturingStep: 'storage',
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					notes: `Wax storage: ${location}${coolingTrayId ? `, tray ${coolingTrayId}` : ''}`
				});
			}

			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cartridgeIds[0] ?? 'batch',
				action: 'UPDATE',
				changedBy: locals.user?.username,
				changedAt: now,
				newData: { status: 'wax_stored', location, count: cartridgeIds.length }
			});
		}

		return { success: true };
	},

	completeRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'completed', runEndTime: now }
		}, { new: true }).lean() as any;

		const cartridgeCount = run?.cartridgeIds?.length ?? 0;
		const operatorRef = { _id: locals.user._id, username: locals.user.username };

		if (run?.deckId) {
			await Equipment.findByIdAndUpdate(run.deckId, {
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
			const tubeLot = await ReceivingLot.findOne({ lotId: run.waxTubeId }).lean() as any;
			if (tubeLot) {
				await ReceivingLot.updateOne({ _id: tubeLot._id }, { $inc: { quantity: -1 } });
				if (tubeLot.part?._id) {
					await recordTransaction({
						transactionType: 'consumption',
						partDefinitionId: tubeLot.part._id,
						lotId: tubeLot._id,
						quantity: 1,
						manufacturingStep: 'wax_filling',
						manufacturingRunId: run._id,
						operatorId: locals.user._id,
						operatorUsername: locals.user.username,
						notes: `Wax filling run — 2ml incubator tube consumed (lot ${run.waxTubeId})`
					});
				}
			} else {
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
		}

		if (run?.waxSourceLot) {
			const FULL_TUBE_VOLUME_UL = 12000;
			const waxLot = await ReceivingLot.findOne({
				$or: [{ lotId: run.waxSourceLot }, { bagBarcode: run.waxSourceLot }, { lotNumber: run.waxSourceLot }]
			}).lean() as any;
			if (waxLot) {
				const consumedBefore = Number(waxLot.consumedUl ?? 0);
				const capUl = Number(waxLot.quantity ?? 0) * FULL_TUBE_VOLUME_UL;
				const consumedAfter = Math.min(capUl, consumedBefore + WAX_FILL_VOLUME_UL);
				const tubesBefore = Math.floor(consumedBefore / FULL_TUBE_VOLUME_UL);
				const tubesAfter = Math.floor(consumedAfter / FULL_TUBE_VOLUME_UL);
				const tubesToDeduct = tubesAfter - tubesBefore;

				const update: Record<string, unknown> = { $set: { consumedUl: consumedAfter } };
				if (tubesToDeduct > 0) (update as any).$inc = { quantity: -tubesToDeduct };
				await ReceivingLot.updateOne({ _id: waxLot._id }, update);

				if (tubesToDeduct > 0 && waxLot.part?._id) {
					await recordTransaction({
						transactionType: 'consumption',
						partDefinitionId: waxLot.part._id,
						lotId: waxLot._id,
						quantity: tubesToDeduct,
						manufacturingStep: 'wax_filling',
						manufacturingRunId: run._id,
						operatorId: locals.user._id,
						operatorUsername: locals.user.username,
						notes: `Wax filling — ${tubesToDeduct} × 15ml wax tube consumed (lot ${run.waxSourceLot})`
					});
				}
			}
		}

		await notifyRunLifecycle({
			runId, runType: 'wax_filling', status: 'completed',
			operator: locals.user?.username, cartridgeCount,
			robot: run?.robot?.name ?? run?.robot?._id
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: { status: 'completed', cartridgeCount }
		});

		throw redirect(303, '/manufacturing/opentron-control');
	}
};
