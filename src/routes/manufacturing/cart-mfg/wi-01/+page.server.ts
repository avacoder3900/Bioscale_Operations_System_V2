/**
 * WI-01: Cartridge Back — "In Oven" (BUCKET-SYSTEM_PLAN.md v2 §6.3).
 *
 * v2 (2026-09-23): fed from production buckets only. Cartridges are already
 * serialized (born at bucket scan-in) and already paid for (shell + label at
 * scan-in, thermoseal at Unpressed), so this step:
 *   1. picks a PRESSED bucket (scan its sticker),
 *   2. scans its cartridges into the oven one at a time — or takes them all,
 *   3. confirms: the scanned cartridges move to status 'backing' (displayed
 *      "In Oven"), the bucket's count drains, and a LotRecord ties the batch
 *      together for traceability.
 *
 * No oven is selected, no oven entry time is recorded and nothing gates on
 * cure time (backing-oven tracking removed app-wide, 2026-09-23). No
 * inventory is withdrawn here. The legacy manual path (pick three lots, scan
 * unknown barcodes) is gone — a barcode that was never scanned into a bucket
 * is refused; use State Change for anomalies.
 */
import { redirect, fail } from '@sveltejs/kit';
import { connectDB, LotRecord, ProcessConfiguration, AuditLog, CartridgeRecord, BucketCycle, ProductionBucket, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import {
	BucketError, STAGE_LABELS, IN_OVEN_STATUS, IN_OVEN_LABEL, SHELL_PART, LABEL_PART, THERMOSEAL_PART,
	getOpenCycle, resolveBucketId, consumeCarts, scrapCarts, cycleLabel
} from '$lib/server/services/bucket-service';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

const PROCESS_TYPE = 'backing';

function generateOutputLot(): string {
	const now = new Date();
	const ds = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	return `LOT-${ds}-${nanoid(4).toUpperCase()}`;
}

async function pressedBuckets() {
	const cycles = await BucketCycle.find({ status: 'open', stage: 'pressed' })
		.select('_id bucketId cycleNumber quantity cartridgeIds sourceLots')
		.sort({ stageEnteredAt: 1 }).lean() as any[];
	const stickers = new Map<string, string | null>(
		(await ProductionBucket.find({ _id: { $in: cycles.map(c => c.bucketId) } }).select('_id barcode').lean() as any[])
			.map((b: any) => [b._id, b.barcode ?? null])
	);
	return cycles.map((c: any) => ({
		bucketId: c.bucketId,
		barcode: stickers.get(c.bucketId) ?? null,
		cycleId: String(c._id),
		cycleNumber: c.cycleNumber,
		quantity: c.quantity ?? 0,
		cartridgeIds: (c.cartridgeIds ?? []) as string[],
		shellLot: (c.sourceLots ?? []).find((l: any) => l.partNumber === SHELL_PART)?.lotId ?? null,
		labelLot: (c.sourceLots ?? []).find((l: any) => l.partNumber === LABEL_PART)?.lotId ?? null,
		thermosealLot: (c.sourceLots ?? []).find((l: any) => l.partNumber === THERMOSEAL_PART)?.lotId ?? null
	}));
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [config, recentLots, buckets, inOven] = await Promise.all([
		ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean(),
		LotRecord.find({ 'processConfig.processType': PROCESS_TYPE }).sort({ createdAt: -1 }).limit(20).lean(),
		pressedBuckets(),
		CartridgeRecord.countDocuments({ status: IN_OVEN_STATUS })
	]);
	const c = config as any;

	return {
		config: {
			processName: c?.processName ?? 'Cartridge Backing (WI-01)',
			handoffPrompt: c?.handoffPrompt ?? 'Backed cartridges ready for wax filling.'
		},
		inOvenLabel: IN_OVEN_LABEL,
		inOvenCount: inOven,
		pressedBuckets: buckets,
		recentLots: (recentLots as any[]).map((l: any) => ({
			lotId: String(l._id),
			bucketBarcode: l.bucketBarcode ?? null,
			outputLotNumber: l.outputLotNumber ?? null,
			quantityProduced: l.quantityProduced ?? 0,
			cartridgeCount: (l.cartridgeIds ?? []).length,
			operatorName: l.operator?.username ?? 'unknown',
			status: l.status ?? 'unknown',
			createdAt: l.createdAt?.toISOString?.() ?? '',
			finishTime: l.finishTime?.toISOString?.() ?? null
		}))
	};
};

export const actions: Actions = {
	/**
	 * Start a batch from a pressed bucket. Creates the LotRecord (traceability +
	 * the WI01- QR ref) with the bucket's lots copied in, and returns the
	 * bucket's member list so the session can validate scans client-side too.
	 */
	checkAndStart: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const bucketIdRaw = (data.get('bucketId') as string)?.trim() || '';
		if (!bucketIdRaw) return fail(400, { checkAndStart: { error: 'Scan the bucket first' } });
		const bucketId = await resolveBucketId(bucketIdRaw);
		if (!bucketId) return fail(400, { checkAndStart: { error: `"${bucketIdRaw}" is not a known bucket` } });
		const cycle = await getOpenCycle(bucketId);
		if (!cycle) return fail(400, { checkAndStart: { error: `Bucket ${bucketId} has no open pass — nothing to put in the oven` } });
		if (cycle.stage !== 'pressed') {
			return fail(400, { checkAndStart: { error: `Bucket ${bucketId} is at ${STAGE_LABELS[cycle.stage as keyof typeof STAGE_LABELS] ?? cycle.stage} — only Pressed buckets go into the oven` } });
		}
		if ((cycle.cartridgeIds ?? []).length === 0) return fail(400, { checkAndStart: { error: `Bucket ${bucketId} is empty` } });

		// One in-progress batch per pass: resume it instead of opening another.
		const existing = await LotRecord.findOne({ bucketCycleId: String(cycle._id), status: 'In Progress' }).select('_id').lean() as any;
		if (existing) {
			return fail(409, { checkAndStart: { error: `Bucket ${bucketId} already has an in-progress batch (${existing._id}) — resume it below`, resumeLotId: String(existing._id) } });
		}

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		const lotId = generateId();
		const now = new Date();
		const lots = (cycle.sourceLots ?? []) as { partNumber?: string; lotId?: string }[];
		const inputLots = [
			{ materialName: 'Cartridge', barcode: lots.find(l => l.partNumber === SHELL_PART)?.lotId ?? '', scanOrder: 1, scannedAt: now },
			{ materialName: 'Thermoseal Laser Cut Sheet', barcode: lots.find(l => l.partNumber === THERMOSEAL_PART)?.lotId ?? '', scanOrder: 2, scannedAt: now },
			{ materialName: 'Barcode', barcode: lots.find(l => l.partNumber === LABEL_PART)?.lotId ?? '', scanOrder: 3, scannedAt: now }
		].filter(l => l.barcode);

		await LotRecord.create({
			_id: lotId,
			qrCodeRef: `WI01-${nanoid(8).toUpperCase()}`,
			outputLotNumber: generateOutputLot(),
			processConfig: config ? { _id: config._id, processName: config.processName, processType: config.processType } : undefined,
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'In Progress',
			startTime: now,
			inputLots,
			plannedQuantity: (cycle.cartridgeIds ?? []).length,
			bucketCycleId: String(cycle._id),
			bucketBarcode: cycle.bucketId,
			stepEntries: [],
			cartridgeIds: []
		});
		await AuditLog.create({
			_id: generateId(), tableName: 'lot_records', recordId: lotId, action: 'INSERT',
			changedBy: locals.user.username, changedAt: now,
			newData: { bucketId: cycle.bucketId, bucketCycleId: String(cycle._id), members: (cycle.cartridgeIds ?? []).length }
		});

		return {
			checkAndStart: {
				success: true, lotId,
				bucketId: cycle.bucketId, cycleId: String(cycle._id), cycleNumber: cycle.cycleNumber,
				members: (cycle.cartridgeIds ?? []) as string[]
			}
		};
	},

	/**
	 * Scan one cartridge from the bucket into the oven. It must be a member of
	 * the batch's bucket pass at status 'pressed'. Moves it to 'backing'
	 * (In Oven), stamps the lot, and draws it out of the bucket.
	 */
	scanBackedCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() || '';
		const barcode = (data.get('barcode') as string)?.trim() || '';
		if (!lotId) return fail(400, { scanBackedCartridge: { error: 'Lot ID required' } });
		if (!barcode) return fail(400, { scanBackedCartridge: { error: 'Cartridge barcode required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { scanBackedCartridge: { error: 'Lot not found' } });
		if (lot.status !== 'In Progress') return fail(400, { scanBackedCartridge: { error: `Lot is "${lot.status}" — only In Progress lots accept scans` } });
		if (!lot.bucketCycleId) return fail(400, { scanBackedCartridge: { error: 'This batch has no bucket — start again from a pressed bucket' } });

		const cart = await CartridgeRecord.findById(barcode).select('status bucket').lean() as any;
		if (!cart) return fail(404, { scanBackedCartridge: { error: `${barcode} was never scanned into a bucket — it can't go into the oven`, barcode } });
		if (cart.bucket?.cycleId !== lot.bucketCycleId) {
			return fail(409, { scanBackedCartridge: { error: `${barcode} is not in bucket ${lot.bucketBarcode ?? ''} — it belongs to ${cart.bucket?.bucketId ?? 'no bucket'} (status ${cart.status})`, barcode } });
		}
		if (cart.status !== 'pressed') {
			return fail(409, { scanBackedCartridge: { error: `${barcode} is ${cart.status === IN_OVEN_STATUS ? `already ${IN_OVEN_LABEL}` : `at ${cart.status}, not pressed`}`, barcode } });
		}

		try {
			await consumeCarts({ cycleId: lot.bucketCycleId, barcodes: [barcode], lotRecordId: lotId, user: { _id: locals.user._id, username: locals.user.username } });
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { scanBackedCartridge: { error: e.message, barcode } });
			throw e;
		}
		const now = new Date();
		await CartridgeRecord.updateOne(
			{ _id: barcode },
			{ $set: {
				status: IN_OVEN_STATUS, statusUpdatedOn: now.toISOString(), priorStatus: 'pressed',
				'backing.parentLotRecordId': lotId, 'backing.lotQrCode': lot.qrCodeRef ?? null,
				'backing.bucketCycleId': lot.bucketCycleId, 'backing.bucketBarcode': lot.bucketBarcode ?? null,
				'backing.operator': { _id: locals.user._id, username: locals.user.username }, 'backing.recordedAt': now
			} }
		);
		await LotRecord.findByIdAndUpdate(lotId, { $addToSet: { cartridgeIds: barcode } });
		await AuditLog.create({
			_id: generateId(), tableName: 'cartridge_records', recordId: barcode, action: 'PHASE_ADVANCE',
			changedBy: locals.user.username, changedAt: now,
			newData: { from: 'pressed', to: IN_OVEN_STATUS, parentLotRecordId: lotId, bucketCycleId: lot.bucketCycleId }
		});
		const updated = await LotRecord.findById(lotId).select('cartridgeIds').lean() as any;
		return { scanBackedCartridge: { success: true, barcode, scannedCount: updated?.cartridgeIds?.length ?? 0 } };
	},

	/**
	 * Everything still in the bucket goes into the oven at once — for the
	 * common case where the whole tub goes in together.
	 */
	takeAll: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() || '';
		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot || lot.status !== 'In Progress' || !lot.bucketCycleId) return fail(400, { takeAll: { error: 'No in-progress bucket batch' } });
		const cycle = await BucketCycle.findById(lot.bucketCycleId).lean() as any;
		const remaining: string[] = cycle?.cartridgeIds ?? [];
		if (remaining.length === 0) return fail(400, { takeAll: { error: 'The bucket is already empty' } });
		const op = { _id: locals.user._id, username: locals.user.username };
		try {
			await consumeCarts({ cycleId: lot.bucketCycleId, barcodes: remaining, lotRecordId: lotId, user: op });
		} catch (e) {
			if (e instanceof BucketError) return fail(e.status, { takeAll: { error: e.message } });
			throw e;
		}
		const now = new Date();
		await CartridgeRecord.updateMany(
			{ _id: { $in: remaining }, status: 'pressed' },
			{ $set: {
				status: IN_OVEN_STATUS, statusUpdatedOn: now.toISOString(), priorStatus: 'pressed',
				'backing.parentLotRecordId': lotId, 'backing.lotQrCode': lot.qrCodeRef ?? null,
				'backing.bucketCycleId': lot.bucketCycleId, 'backing.bucketBarcode': lot.bucketBarcode ?? null,
				'backing.operator': op, 'backing.recordedAt': now
			} }
		);
		await LotRecord.findByIdAndUpdate(lotId, { $addToSet: { cartridgeIds: { $each: remaining } } });
		await AuditLog.create({
			_id: generateId(), tableName: 'lot_records', recordId: lotId, action: 'TAKE_ALL',
			changedBy: locals.user.username, changedAt: now, newData: { cartridgeIds: remaining, to: IN_OVEN_STATUS }
		});
		const updated = await LotRecord.findById(lotId).select('cartridgeIds').lean() as any;
		return { takeAll: { success: true, taken: remaining, scannedCount: updated?.cartridgeIds?.length ?? 0 } };
	},

	/**
	 * Undo a scan before confirm: the cartridge goes back to 'pressed' and
	 * back into the bucket. (Membership is restored directly — consumeCarts has
	 * no inverse — and the pass is reopened if the scan had drained it.)
	 */
	removeBackedCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() || '';
		const barcode = (data.get('barcode') as string)?.trim() || '';
		if (!lotId || !barcode) return fail(400, { removeBackedCartridge: { error: 'Lot ID and barcode required' } });
		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot || lot.status !== 'In Progress') return fail(400, { removeBackedCartridge: { error: 'Batch is not in progress' } });
		if (!(lot.cartridgeIds ?? []).includes(barcode)) return fail(400, { removeBackedCartridge: { error: 'Cartridge is not in this batch' } });
		const now = new Date();
		await CartridgeRecord.updateOne({ _id: barcode, status: IN_OVEN_STATUS }, { $set: { status: 'pressed', statusUpdatedOn: now.toISOString() }, $unset: { 'backing.parentLotRecordId': '', 'backing.lotQrCode': '', 'backing.operator': '', 'backing.recordedAt': '' } });
		await LotRecord.findByIdAndUpdate(lotId, { $pull: { cartridgeIds: barcode } });
		if (lot.bucketCycleId) {
			await BucketCycle.updateOne({ _id: lot.bucketCycleId }, { $addToSet: { cartridgeIds: barcode }, $inc: { quantity: 1 }, $set: { status: 'open', closedAt: null } });
			await ProductionBucket.updateOne({ _id: lot.bucketBarcode }, { $set: { state: 'in_use', currentCycleId: lot.bucketCycleId, spotCheckPending: false } });
		}
		await AuditLog.create({
			_id: generateId(), tableName: 'cartridge_records', recordId: barcode, action: 'GO_BACK',
			changedBy: locals.user.username, changedAt: now, oldData: { status: IN_OVEN_STATUS, parentLotRecordId: lotId },
			reason: 'Operator removed mis-scanned cartridge before batch confirm'
		});
		return { removeBackedCartridge: { success: true, barcode } };
	},

	/**
	 * Confirm the batch. Cartridges scrapped at the oven door are discarded
	 * from the bucket pass (journal = the scrap reason). Nothing is withdrawn
	 * from inventory here — every part was consumed upstream; the discard
	 * itself scraps what the cart physically was.
	 */
	confirmComplete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() || '';
		const scrapIds = String(data.get('scrapIds') ?? '').split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
		const scrapReason = (data.get('scrapReason') as string)?.trim() || '';
		const notes = (data.get('notes') as string)?.trim() || '';
		if (!lotId) return fail(400, { confirmComplete: { error: 'Lot ID required' } });
		if (scrapIds.length > 0 && !scrapReason) return fail(400, { confirmComplete: { error: 'Scrap reason is required when any cartridges are scrapped' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { confirmComplete: { error: 'Lot not found' } });
		if (lot.status === 'Completed') return fail(409, { confirmComplete: { error: 'Lot already completed' } });
		const actualCount = (lot.cartridgeIds ?? []).length;
		if (actualCount <= 0) return fail(400, { confirmComplete: { error: 'No cartridges scanned — scan carts from the bucket into the oven first' } });

		const op = { _id: locals.user._id, username: locals.user.username };
		const bucketNotes: string[] = [];
		if (scrapIds.length > 0 && lot.bucketCycleId) {
			try {
				await scrapCarts({ cycleId: lot.bucketCycleId, barcodes: scrapIds, journal: `WI-01 lot ${lotId}: ${scrapReason}`, user: op, relatedId: lotId });
			} catch (e) {
				if (!(e instanceof BucketError)) throw e;
				bucketNotes.push(`Bucket could not record the scrap: ${e.message}`);
			}
		}

		const now = new Date();
		const startTime = lot.startTime ?? now;
		await LotRecord.findByIdAndUpdate(lotId, {
			$set: {
				status: 'Completed', finishTime: now, cycleTime: Math.round((now.getTime() - startTime.getTime()) / 1000),
				quantityProduced: actualCount, scrapCount: scrapIds.length,
				scrapDetail: { cartridge: scrapIds.length, thermoseal: 0, barcode: 0 },
				scrapReason: scrapReason || undefined, notes: notes || undefined
			}
		});
		await AuditLog.create({
			_id: generateId(), tableName: 'lot_records', recordId: lotId, action: 'UPDATE',
			changedBy: locals.user.username, changedAt: now,
			newData: { actualCount, cartridgeIds: lot.cartridgeIds ?? [], scrapIds, scrapReason: scrapReason || undefined, notes: notes || undefined, bucketCycleId: lot.bucketCycleId, inventoryWithdrawn: 'none — consumed upstream in the bucket', bucketNotes: bucketNotes.length ? bucketNotes : undefined }
		});

		const cycle = lot.bucketCycleId ? await BucketCycle.findById(lot.bucketCycleId).select('quantity status bucketId cycleNumber').lean() as any : null;
		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		return {
			confirmComplete: {
				success: true,
				handoffPrompt: config?.handoffPrompt ?? 'Backed cartridges ready for wax filling.',
				bucket: cycle ? { bucketId: lot.bucketBarcode ?? cycle.bucketId, label: cycleLabel(cycle.bucketId, cycle.cycleNumber), qtyAfter: cycle.quantity ?? 0, closed: cycle.status !== 'open' } : null,
				bucketNotes
			}
		};
	},

	/** Append a timestamped note to an in-progress lot */
	addSessionNote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const note = (data.get('note') as string)?.trim() || '';
		if (!lotId) return fail(400, { addSessionNote: { error: 'Lot ID required' } });
		if (!note) return fail(400, { addSessionNote: { error: 'Note text is required' } });
		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { addSessionNote: { error: 'Lot not found' } });
		const entry = `[${new Date().toISOString()}] (${locals.user.username}) ${note}`;
		const updatedNotes = lot.notes ? `${lot.notes}\n${entry}` : entry;
		await LotRecord.findByIdAndUpdate(lotId, { $set: { notes: updatedNotes } });
		await AuditLog.create({ _id: generateId(), tableName: 'lot_records', recordId: lotId, action: 'UPDATE', changedBy: locals.user.username, changedAt: new Date(), newData: { noteAdded: entry } });
		return { addSessionNote: { success: true, notes: updatedNotes } };
	},

	/**
	 * Discard an in-progress batch. Any cartridges already scanned go back to
	 * 'pressed' and back into their bucket, so nothing is stranded.
	 */
	deleteLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { deleteLot: { error: 'Lot ID required' } });
		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { deleteLot: { error: 'Lot not found' } });
		if (lot.status !== 'In Progress') return fail(400, { deleteLot: { error: `Cannot delete lot in status "${lot.status}". Only In Progress lots can be deleted.` } });

		const scanned: string[] = lot.cartridgeIds ?? [];
		if (scanned.length && lot.bucketCycleId) {
			const now = new Date();
			await CartridgeRecord.updateMany({ _id: { $in: scanned }, status: IN_OVEN_STATUS }, { $set: { status: 'pressed', statusUpdatedOn: now.toISOString() }, $unset: { 'backing.parentLotRecordId': '', 'backing.lotQrCode': '', 'backing.operator': '', 'backing.recordedAt': '' } });
			await BucketCycle.updateOne({ _id: lot.bucketCycleId }, { $addToSet: { cartridgeIds: { $each: scanned } }, $inc: { quantity: scanned.length }, $set: { status: 'open', closedAt: null } });
			await ProductionBucket.updateOne({ _id: lot.bucketBarcode }, { $set: { state: 'in_use', currentCycleId: lot.bucketCycleId, spotCheckPending: false } });
		}
		await AuditLog.create({
			_id: generateId(), tableName: 'lot_records', recordId: lotId, action: 'DELETE',
			changedBy: locals.user.username, changedAt: new Date(),
			oldData: { status: lot.status, plannedQuantity: lot.plannedQuantity, operator: lot.operator, bucketCycleId: lot.bucketCycleId, returnedToBucket: scanned },
			reason: 'Operator-initiated discard of in-progress backing batch'
		});
		await LotRecord.deleteOne({ _id: lotId });
		return { deleteLot: { success: true, lotId } };
	},

	/** Resume an in-progress lot */
	resumeLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { resumeLot: { error: 'Lot ID required' } });
		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { resumeLot: { error: 'Lot not found' } });
		if (lot.status !== 'In Progress') return fail(400, { resumeLot: { error: `This batch is "${lot.status}" — finished batches cannot be resumed.` } });
		const cycle = lot.bucketCycleId ? await BucketCycle.findById(lot.bucketCycleId).select('bucketId cycleNumber cartridgeIds').lean() as any : null;
		return {
			resumeLot: {
				success: true, lotId, cartridgeIds: lot.cartridgeIds ?? [],
				bucketId: lot.bucketBarcode ?? null, cycleId: lot.bucketCycleId ?? null, cycleNumber: cycle?.cycleNumber ?? null,
				members: (cycle?.cartridgeIds ?? []) as string[]
			}
		};
	}
};

export const config = { maxDuration: 60 };
