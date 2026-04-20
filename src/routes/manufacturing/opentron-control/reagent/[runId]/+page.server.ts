/**
 * Opentron Control — Reagent post-OT-2 flow (steps 4-6: inspection, top sealing, storage).
 *
 * Actions here are functionally identical to the ones in reagent-filling/+page.server.ts.
 * If you fix a bug in one, fix it in the other too.
 */
import { redirect, fail, error } from '@sveltejs/kit';
import {
	connectDB, ReagentBatchRecord, CartridgeRecord, AssayDefinition,
	ManufacturingSettings, Equipment, EquipmentLocation, generateId, AuditLog
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { checkTrayConflict } from '$lib/server/manufacturing/resource-locks';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

function toStage(status: string | null | undefined): string | null {
	if (!status) return null;
	const map: Record<string, string> = {
		Inspection: 'Inspection', inspection: 'Inspection',
		'Top Sealing': 'Top Sealing', top_sealing: 'Top Sealing',
		Storage: 'Storage', storage: 'Storage',
		Completed: 'Storage'
	};
	return map[status] ?? null;
}

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const run = await ReagentBatchRecord.findById(params.runId).lean() as any;
	if (!run) throw error(404, 'Reagent run not found');
	if (!run.robotReleasedAt) throw error(400, 'This run is still on the OT-2 — access it from the Reagent Filling page');

	const stage = toStage(run.status);
	const settingsDoc = await ManufacturingSettings.findById('default').lean() as any;
	const maxTimeBeforeSealMin: number = settingsDoc?.reagentFilling?.maxTimeBeforeSealMin ?? 60;

	// Resolve robot name — reagent records sometimes store only robot._id,
	// leaving the header to render a raw nanoid.
	let robotName = run.robot?.name ?? '';
	if (!robotName && run.robot?._id) {
		const robotDoc = await Equipment.findById(run.robot._id).select('name').lean() as any;
		if (robotDoc?.name) robotName = robotDoc.name;
	}

	const rejectionCodes = (settingsDoc?.rejectionReasonCodes ?? [])
		.filter((r: any) => !r.processType || r.processType === 'reagent')
		.map((r: any, i: number) => ({
			id: r._id ? String(r._id) : String(i), code: r.code ?? '', label: r.label ?? '',
			processType: r.processType ?? 'reagent', sortOrder: r.sortOrder ?? i
		}));

	const cartridgesFilled = (run.cartridgesFilled ?? []).map((cf: any) => ({
		cartridgeId: cf.cartridgeId ?? '',
		deckPosition: cf.deckPosition ?? null,
		inspectionStatus: cf.inspectionStatus ?? 'Pending',
		inspectionReason: cf.inspectionReason ?? null,
		topSealBatchId: cf.topSealBatchId ?? null,
		storageLocation: cf.storageLocation ?? null,
		storedAt: cf.storedAt ? new Date(cf.storedAt).toISOString() : null
	}));

	const sealBatches = (run.sealBatches ?? []).map((b: any) => ({
		batchId: String(b._id),
		topSealLotId: b.topSealLotId ?? '',
		operatorName: b.operator?.username ?? '',
		cartridgeIds: b.cartridgeIds ?? [],
		status: b.status ?? 'in_progress',
		completionTime: b.completionTime ? new Date(b.completionTime).toISOString() : null
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

	// Top-seal deadline: warn after maxTimeBeforeSealMin since robot released
	const releasedAt = new Date(run.robotReleasedAt).getTime();
	const sealDeadlineMs = releasedAt + maxTimeBeforeSealMin * 60000;
	const sealOverdue = Date.now() > sealDeadlineMs;
	const sealMinRemaining = sealOverdue ? 0 : Math.ceil((sealDeadlineMs - Date.now()) / 60000);

	return {
		runId: String(run._id),
		stage,
		robotName,
		assayTypeName: run.assayType?.name ?? '',
		cartridgesFilled: JSON.parse(JSON.stringify(cartridgesFilled)),
		sealBatches: JSON.parse(JSON.stringify(sealBatches)),
		rejectionCodes,
		fridges: JSON.parse(JSON.stringify(fridges)),
		sealDeadline: { sealOverdue, sealMinRemaining, maxTimeBeforeSealMin },
		cartridgeCount: run.cartridgesFilled?.length ?? run.cartridgeCount ?? 0
	};
};

export const actions: Actions = {
	completeInspectionBatch: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		// Prefer the URL param — the form's hidden runId field has been unreliable
		// in practice (empty on submit), producing a spurious "Run not found".
		const runId = (data.get('runId') as string) || (params.runId as string);
		const rejectedCartridgesRaw = data.get('rejectedCartridges') as string;
		const trayId = ((data.get('trayId') as string | null) ?? '').trim() || undefined;
		const now = new Date();

		let rejectedCartridges: { cartridgeId: string; reason: string; status: string }[] = [];
		if (rejectedCartridgesRaw) {
			try { rejectedCartridges = JSON.parse(rejectedCartridgesRaw); } catch { /* ignore */ }
		}

		const run = await ReagentBatchRecord.findById(runId).lean() as any;
		if (!run) return fail(404, { error: 'Run not found' });

		// Tray conflict runs at scan time on the page. No duplicate check here.

		const rejectedMap = new Map(rejectedCartridges.map((c: any) => [c.cartridgeId, c]));
		const updatedCartridges = (run.cartridgesFilled ?? []).map((cf: any) => {
			const rejected = rejectedMap.get(cf.cartridgeId);
			if (rejected) {
				return { ...cf, inspectionStatus: rejected.status ?? 'Rejected', inspectionReason: rejected.reason ?? null,
					inspectedBy: { _id: locals.user._id, username: locals.user.username }, inspectedAt: now };
			}
			return { ...cf, inspectionStatus: cf.inspectionStatus === 'Pending' ? 'Accepted' : cf.inspectionStatus,
				inspectedBy: { _id: locals.user._id, username: locals.user.username }, inspectedAt: now };
		});

		const updateFields: Record<string, any> = {
			cartridgesFilled: updatedCartridges,
			status: 'Top Sealing'
		};
		if (trayId) updateFields.trayId = trayId;
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: updateFields });

		for (const rej of rejectedCartridges) {
			await CartridgeRecord.findOneAndUpdate(
				{ _id: rej.cartridgeId, 'reagentInspection.recordedAt': { $exists: false } },
				{
					$set: {
						'reagentInspection.status': rej.status ?? 'Rejected',
						'reagentInspection.reason': rej.reason ?? undefined,
						'reagentInspection.operator': { _id: locals.user._id, username: locals.user.username },
						'reagentInspection.timestamp': now,
						'reagentInspection.recordedAt': now,
						status: 'voided'
					}
				}
			);
			await recordTransaction({
				transactionType: 'scrap', cartridgeRecordId: rej.cartridgeId, quantity: 1,
				manufacturingStep: 'reagent_filling', manufacturingRunId: runId,
				operatorId: locals.user._id, operatorUsername: locals.user.username,
				scrapReason: rej.reason ?? 'Reagent inspection rejection', scrapCategory: 'reagent_defect',
				notes: `Reagent inspection rejection: ${rej.reason ?? 'No reason'}`
			});
		}

		// Run has been released to the Top Sealing queue — send the operator back
		// to the Opentron Control homepage so they can start another run. Top
		// Sealing + Storage can be picked up later from the post-OT-2 queue.
		redirect(303, '/manufacturing/opentron-control');
	},

	completeInspection: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Top Sealing' } });
		return { success: true };
	},

	createTopSealBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		const topSealLotId = data.get('topSealLotId') as string;
		if (!topSealLotId?.trim()) return fail(400, { error: 'Top seal lot ID is required' });
		const batchId = generateId();
		await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$push: {
				sealBatches: {
					_id: batchId, topSealLotId: topSealLotId.trim(),
					operator: { _id: locals.user._id, username: locals.user.username },
					firstScanTime: new Date(), cartridgeIds: [], status: 'in_progress'
				}
			}
		});
		return { success: true, batchId };
	},

	scanCartridgeForSeal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		const batchId = data.get('batchId') as string;
		const cartridgeRecordId = data.get('cartridgeRecordId') as string;
		if (!cartridgeRecordId) return fail(400, { error: 'Cartridge ID required' });
		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'sealBatches._id': batchId },
			{ $addToSet: { 'sealBatches.$.cartridgeIds': cartridgeRecordId } }
		);
		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'cartridgesFilled.cartridgeId': cartridgeRecordId },
			{ $set: { 'cartridgesFilled.$.topSealBatchId': batchId } }
		);
		return { success: true };
	},

	completeSealBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		const batchId = data.get('batchId') as string;
		const now = new Date();

		const run = await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'sealBatches._id': batchId },
			{ $set: { 'sealBatches.$.status': 'completed', 'sealBatches.$.completionTime': now } },
			{ new: true }
		).lean() as any;

		const batch = (run?.sealBatches ?? []).find((b: any) => String(b._id) === batchId);
		if (batch?.cartridgeIds?.length) {
			const bulkOps = batch.cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'topSeal.recordedAt': { $exists: false } },
					update: {
						$set: {
							'topSeal.batchId': batchId, 'topSeal.topSealLotId': batch.topSealLotId,
							'topSeal.operator': { _id: locals.user._id, username: locals.user.username },
							'topSeal.timestamp': now, 'topSeal.recordedAt': now, status: 'sealed'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			const topSealPartId = await resolvePartId('PT-CT-103');
			for (const cid of batch.cartridgeIds) {
				await recordTransaction({
					transactionType: 'consumption', partDefinitionId: topSealPartId ?? undefined,
					cartridgeRecordId: cid, quantity: 1, manufacturingStep: 'top_seal',
					manufacturingRunId: runId, operatorId: locals.user._id, operatorUsername: locals.user.username,
					lotId: batch.topSealLotId ?? undefined, notes: `Top seal applied (batch ${batchId})`
				});
			}

			await AuditLog.create({
				_id: generateId(), tableName: 'reagent_batch_records', recordId: runId,
				action: 'UPDATE', changedBy: locals.user?.username, changedAt: now,
				newData: { sealBatchId: batchId, status: 'completed', topSealLotId: batch.topSealLotId }
			});
		}
		return { success: true };
	},

	rejectAtSeal: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeId = data.get('cartridgeId') as string;
		const now = new Date();
		if (!cartridgeId) return fail(400, { error: 'Cartridge ID required' });

		await ReagentBatchRecord.findOneAndUpdate(
			{ _id: runId, 'cartridgesFilled.cartridgeId': cartridgeId },
			{
				$set: {
					'cartridgesFilled.$.inspectionStatus': 'Rejected',
					'cartridgesFilled.$.inspectionReason': 'Rejected at top sealing',
					'cartridgesFilled.$.inspectedBy': { _id: locals.user._id, username: locals.user.username },
					'cartridgesFilled.$.inspectedAt': now
				}
			}
		);
		await CartridgeRecord.findOneAndUpdate(
			{ _id: cartridgeId },
			{ $set: { status: 'voided', voidedAt: now, voidReason: 'Rejected at top sealing' } }
		);
		return { success: true };
	},

	transitionToStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		await ReagentBatchRecord.findByIdAndUpdate(runId, { $set: { status: 'Storage' } });
		return { success: true };
	},

	recordBatchStorage: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const runId = data.get('runId') as string;
		const cartridgeIdsRaw = data.get('cartridgeIds') as string;
		const location = data.get('location') as string;
		const now = new Date();

		let cartridgeIds: string[] = [];
		try { cartridgeIds = JSON.parse(cartridgeIdsRaw); } catch { /* ignore */ }

		if (cartridgeIds.length > 0) {
			for (const cid of cartridgeIds) {
				await ReagentBatchRecord.findOneAndUpdate(
					{ _id: runId, 'cartridgesFilled.cartridgeId': cid },
					{ $set: { 'cartridgesFilled.$.storageLocation': location, 'cartridgesFilled.$.storedAt': now } }
				);
			}
			const bulkOps = cartridgeIds.map((cid: string) => ({
				updateOne: {
					filter: { _id: cid, 'storage.recordedAt': { $exists: false } },
					update: {
						$set: {
							'storage.fridgeName': location, 'storage.locationId': location,
							'storage.operator': { _id: locals.user._id, username: locals.user.username },
							'storage.timestamp': now, 'storage.recordedAt': now, status: 'stored'
						}
					}
				}
			}));
			await CartridgeRecord.bulkWrite(bulkOps);

			for (const cid of cartridgeIds) {
				await recordTransaction({
					transactionType: 'creation', cartridgeRecordId: cid, quantity: 1,
					manufacturingStep: 'storage', manufacturingRunId: runId,
					operatorId: locals.user._id, operatorUsername: locals.user.username,
					notes: `Stored in ${location}`
				});
			}
			await AuditLog.create({
				_id: generateId(), tableName: 'cartridge_records', recordId: cartridgeIds[0] ?? 'batch',
				action: 'UPDATE', changedBy: locals.user?.username, changedAt: now,
				newData: { status: 'stored', location, count: cartridgeIds.length }
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

		const run = await ReagentBatchRecord.findByIdAndUpdate(runId, {
			$set: { status: 'Completed', finalizedAt: now, runEndTime: now }
		}, { new: true }).lean() as any;

		if (run?.deckId) {
			const cartridgeCount = run?.cartridgesFilled?.length ?? 0;
			await Equipment.findByIdAndUpdate(run.deckId, {
				$set: { lastUsed: now },
				$push: {
					usageLog: {
						_id: generateId(), usageType: 'run_complete', runId: run._id,
						quantityChanged: cartridgeCount,
						operator: { _id: locals.user._id, username: locals.user.username },
						notes: `Reagent filling run complete — ${cartridgeCount} cartridges filled`,
						createdAt: now
					}
				}
			});
		}

		await AuditLog.create({
			_id: generateId(), tableName: 'reagent_batch_records', recordId: runId,
			action: 'UPDATE', changedBy: locals.user?.username, changedAt: now,
			newData: { status: 'Completed' }
		});

		throw redirect(303, '/manufacturing/opentron-control');
	}
};
