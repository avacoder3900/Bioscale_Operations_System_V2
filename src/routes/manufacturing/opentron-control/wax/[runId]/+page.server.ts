/**
 * Opentron Control — Wax post-OT-2 flow (steps 4-6: cooling, QC, storage).
 *
 * Actions here are functionally identical to the ones in wax-filling/+page.server.ts.
 * They're duplicated rather than shared via module because SvelteKit actions
 * must be defined on their own route, and extracting to a shared service is a
 * future refactor. If you fix a bug in one, fix it in the other too.
 */
import { redirect, fail, error } from '@sveltejs/kit';
import mongoose from 'mongoose';
import {
	connectDB, WaxFillingRun, CartridgeRecord, Consumable,
	ManufacturingSettings, generateId, Equipment, EquipmentLocation,
	AuditLog, ReceivingLot
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { resolveFridgeId } from '$lib/server/services/equipment-resolve';
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

	// Go-back is allowed from QC or Storage, as long as no cartridge has been
	// committed to a fridge yet. Once waxStorage.recordedAt is set on any
	// cartridge, the run is a one-way street — fridge placement is the commit.
	const anyStored = (cartridgesRaw as any[]).some((c: any) => !!c.waxStorage?.recordedAt);
	const canGoBack = (stage === 'QC' || stage === 'Storage') && !anyStored;
	const goBackTargetStage = stage === 'Storage' ? 'QC' : stage === 'QC' ? 'Awaiting Removal' : null;

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
		canGoBack,
		goBackTargetStage,
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
		const rejectedRaw = (data.get('rejectedCartridges') as string) || '[]';
		const now = new Date();

		// Parse the rejections payload sent by QCInspection. Empty list is
		// valid (= operator accepted everything).
		let rejectedList: { cartridgeId: string; reasonCode: string }[] = [];
		try {
			const parsed = JSON.parse(rejectedRaw);
			if (Array.isArray(parsed)) rejectedList = parsed;
		} catch {
			return fail(400, { error: 'Invalid rejectedCartridges payload' });
		}

		const runBeforeQc = await WaxFillingRun.findById(runId).select('coolingConfirmedAt coolingConfirmedTime').lean() as any;
		const confirmedAt = runBeforeQc?.coolingConfirmedAt ?? runBeforeQc?.coolingConfirmedTime;
		if (confirmedAt) {
			// Minimum cool-down before QC is configurable via
			// ManufacturingSettings.waxFilling.minCoolingBeforeQcMin (default 2 min).
			// Editable from the wax-filling settings page.
			const settingsDocQc = await ManufacturingSettings.findById('default').select('waxFilling.minCoolingBeforeQcMin').lean() as any;
			const minCoolMin = settingsDocQc?.waxFilling?.minCoolingBeforeQcMin ?? 2;
			const minCoolMs = minCoolMin * 60 * 1000;
			const elapsedMs = Date.now() - new Date(confirmedAt).getTime();
			if (elapsedMs < minCoolMs) {
				const remainingMin = Math.ceil((minCoolMs - elapsedMs) / 60000);
				return fail(400, { error: `Cartridges must cool for at least ${minCoolMin} minute${minCoolMin === 1 ? '' : 's'}. ${remainingMin} min remaining.` });
			}
		}

		const run = await WaxFillingRun.findByIdAndUpdate(runId, {
			$set: { status: 'Storage', runEndTime: now }
		}, { new: true }).lean() as any;

		// Apply operator rejections BEFORE the waxFilling/accept loops so the
		// subsequent filters correctly exclude scrapped cartridges. Mirrors the
		// per-cartridge rejectCartridge action (still kept for one-off rejects
		// from other surfaces).
		const rejectedIdSet = new Set<string>();
		if (rejectedList.length > 0 && run?.cartridgeIds?.length) {
			const validIds = new Set<string>((run.cartridgeIds as string[]).map(String));
			for (const r of rejectedList) {
				if (!validIds.has(String(r.cartridgeId))) continue;
				rejectedIdSet.add(String(r.cartridgeId));
				const reason = r.reasonCode || '';
				await CartridgeRecord.findOneAndUpdate(
					{ _id: r.cartridgeId, 'waxQc.recordedAt': { $exists: false } },
					{
						$set: {
							'waxQc.status': 'Rejected',
							'waxQc.rejectionReason': reason,
							'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
							'waxQc.timestamp': now,
							'waxQc.recordedAt': now,
							status: 'scrapped',
							voidedAt: now,
							voidReason: `Wax QC rejection: ${reason}`
						}
					}
				);
				await recordTransaction({
					transactionType: 'scrap',
					cartridgeRecordId: r.cartridgeId,
					quantity: 1,
					manufacturingStep: 'wax_filling',
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					scrapReason: reason,
					scrapCategory: 'wax_defect',
					notes: `Wax QC rejection: ${reason}`
				});
			}
		}

		if (run?.cartridgeIds?.length) {
			// Filter excludes scrapped cartridges so we don't stomp the
			// rejection's status='scrapped' back to 'wax_filled'.
			const bulkOps = run.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxFilling.recordedAt': { $exists: false }, status: { $ne: 'scrapped' } },
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

			// Write waxQc.status='Accepted' for every cartridge that wasn't rejected
			// during QC. Rejects already carry waxQc.recordedAt (set above or from
			// rejectCartridge), so the recordedAt-not-set filter excludes them.
			const acceptOps = run.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxQc.recordedAt': { $exists: false }, status: { $ne: 'scrapped' } },
					update: {
						$set: {
							'waxQc.status': 'Accepted',
							'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
							'waxQc.timestamp': now,
							'waxQc.recordedAt': now
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(acceptOps);

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

		// Wax rejects use status='scrapped' — distinct from generic 'voided'
		// used for operator-initiated removals. Cartridge stays in the system.
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId, 'waxQc.recordedAt': { $exists: false } },
			{
				$set: {
					'waxQc.status': 'Rejected',
					'waxQc.rejectionReason': rejectionReason,
					'waxQc.operator': { _id: locals.user._id, username: locals.user.username },
					'waxQc.timestamp': now,
					'waxQc.recordedAt': now,
					status: 'scrapped',
					voidedAt: now,
					voidReason: `Wax QC rejection: ${rejectionReason}`
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
		// S1a: resolve the scanned fridge reference to Equipment._id once per
		// batch, then write it to waxStorage.locationId. Keep the raw scanned
		// value in waxStorage.location as the denormalized display field so
		// operators still see what they scanned. If resolution fails the write
		// still happens with locationId=null — readers fall back to `location`
		// until S1b back-fills.
		const resolvedLocationId = await resolveFridgeId(location);
		if (cartridgeIds.length > 0) {
			// Storage fields are written here (fridge, tray, operator, timestamp)
			// but status stays at 'wax_filled' until completeRun commits the whole
			// batch. This prevents reagent filling from picking up cartridges
			// before the wax run is closed — see recent state-machine fix.
			const bulkOps = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'waxStorage.recordedAt': { $exists: false } },
					update: {
						$set: {
							'waxStorage.locationId': resolvedLocationId,
							'waxStorage.location': location,
							'waxStorage.coolingTrayId': coolingTrayId,
							'waxStorage.operator': { _id: locals.user._id, username: locals.user.username },
							'waxStorage.timestamp': now,
							'waxStorage.recordedAt': now
							// status intentionally NOT set — completeRun does the wax_stored flip.
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

		// Commit point: flip every cartridge in the run that has its waxStorage
		// recorded from status='wax_filled' → 'wax_stored'. This is the gate
		// that prevents reagent filling from picking up cartridges before the
		// wax run is explicitly completed. Filter on waxStorage.recordedAt so
		// we don't promote cartridges that never made it through fridge assign.
		if (run?.cartridgeIds?.length) {
			await CartridgeRecord.updateMany(
				{
					_id: { $in: run.cartridgeIds },
					status: 'wax_filled',
					'waxStorage.recordedAt': { $exists: true }
				},
				{ $set: { status: 'wax_stored' } }
			);
		}

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
	},

	/**
	 * Rewind the run one stage. Storage → QC undoes completeQC; QC → Awaiting
	 * Removal undoes confirmCooling. Refuses if any cartridge is already in a
	 * fridge — fridge placement is the commit point.
	 */
	goBack: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const runId = data.get('runId') as string;
		const now = new Date();

		const run = await WaxFillingRun.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		const cartIds: string[] = run.cartridgeIds ?? [];

		const storedCount = cartIds.length
			? await CartridgeRecord.countDocuments({
				_id: { $in: cartIds },
				'waxStorage.recordedAt': { $exists: true }
			})
			: 0;
		if (storedCount > 0) {
			return fail(400, { error: `Cannot go back — ${storedCount} cartridge${storedCount === 1 ? '' : 's'} already placed in a fridge. Storage is a commit point.` });
		}

		const current = run.status;
		let targetStage: 'QC' | 'Awaiting Removal';

		if (current === 'Storage' || current === 'storage') {
			// Undo completeQC: revert waxQc, clear completeQC-written waxFilling
			// fields, restore status to wax_filling, drop phantom wax_filling
			// consumption transactions.
			targetStage = 'QC';

			await WaxFillingRun.updateOne(
				{ _id: runId },
				{ $set: { status: 'QC' }, $unset: { runEndTime: '' } }
			);

			if (cartIds.length > 0) {
				await CartridgeRecord.updateMany(
					{ _id: { $in: cartIds } },
					{
						$set: { status: 'wax_filling' },
						$unset: {
							waxQc: '',
							voidedAt: '',
							voidReason: '',
							'waxFilling.waxTubeId': '',
							'waxFilling.waxSourceLot': '',
							'waxFilling.runStartTime': '',
							'waxFilling.runEndTime': '',
							'waxFilling.recordedAt': ''
						}
					}
				);

				// Delete the wax_filling consumption inventory_transactions written
				// by completeQC for this run. No PartDefinition inventoryCount to
				// restore — PT-CT-105 has no part_definitions row so the original
				// writes had partDefinitionId=undefined and no inventoryCount was
				// decremented. Also delete any scrap tx from the aborted QC's
				// rejections so re-doing QC produces a clean tx history.
				await mongoose.connection.db!.collection('inventory_transactions').updateMany(
					{
						manufacturingRunId: runId,
						manufacturingStep: 'wax_filling',
						transactionType: { $in: ['consumption', 'scrap'] },
						cartridgeRecordId: { $in: cartIds },
						retractedAt: { $exists: false }
					},
					{
						$set: {
							retractedBy: locals.user?.username ?? 'unknown',
							retractedAt: now,
							retractionReason: `Go Back: ${current} → ${targetStage}`
						}
					}
				);
			}
		} else if (current === 'QC' || current === 'qc') {
			// Undo confirmCooling: revert cooling-confirmed marker and the
			// ovenCure stamp we wrote at cooling time.
			targetStage = 'Awaiting Removal';

			await WaxFillingRun.updateOne(
				{ _id: runId },
				{
					$set: { status: 'Awaiting Removal' },
					$unset: { coolingConfirmedTime: '', coolingConfirmedAt: '' }
				}
			);

			if (cartIds.length > 0) {
				await CartridgeRecord.updateMany(
					{ _id: { $in: cartIds } },
					{ $unset: { ovenCure: '' } }
				);
			}
		} else {
			return fail(400, { error: `Cannot go back from stage "${current}".` });
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'wax_filling_runs',
			recordId: runId,
			action: 'GO_BACK',
			changedBy: locals.user?.username,
			changedAt: now,
			newData: {
				fromStage: current,
				toStage: targetStage,
				cartridgeCount: cartIds.length
			}
		});

		return { success: true };
	}
};
