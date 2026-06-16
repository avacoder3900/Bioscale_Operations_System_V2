/**
 * WI-01: Cartridge Backing
 * Simplified flow: Start → Qty + Scan Lots → Check Inventory → Work → Confirm → Withdraw
 *
 * Materials consumed per cartridge:
 *   1x Cartridge (PT-CT-104)
 *   1x Thermoseal Laser Cut Sheet (PT-CT-112)
 *   1x Barcode (PT-CT-106)
 */
import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, LotRecord, ProcessConfiguration,
	PartDefinition, AuditLog, Equipment, CartridgeRecord, ReceivingLot,
	InventoryTransaction, generateId
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

const PROCESS_TYPE = 'backing';

// Part numbers consumed per cartridge (1:1 ratio each)
const CONSUMED_PARTS = [
	{ partNumber: 'PT-CT-104', name: 'Cartridge' },
	{ partNumber: 'PT-CT-112', name: 'Thermoseal Laser Cut Sheet' },
	{ partNumber: 'PT-CT-106', name: 'Barcode' }
];

/**
 * Validate that a scanned lot barcode belongs to the expected part. Used
 * inline during the scan step so operators cannot mis-scan a Cartridge
 * lot into the Thermoseal slot (etc.).
 *
 * A lot is considered valid when a ReceivingLot exists with matching
 * lotId and part.partNumber, and its status is not 'rejected'/'returned'.
 */
async function validateLotForPart(lotId: string, partNumber: string):
	Promise<{ ok: true; lot: any } | { ok: false; reason: string }>
{
	if (!lotId) return { ok: false, reason: 'Barcode is empty.' };
	const lot = await ReceivingLot.findOne({ lotId }).lean() as any;
	if (!lot) {
		return { ok: false, reason: `Lot "${lotId}" is not in the receiving system.` };
	}
	if (lot.part?.partNumber !== partNumber) {
		return {
			ok: false,
			reason: `Lot "${lotId}" is ${lot.part?.partNumber ?? 'an unknown part'} — expected ${partNumber}.`
		};
	}
	if (lot.status === 'rejected' || lot.status === 'returned') {
		return { ok: false, reason: `Lot "${lotId}" has status "${lot.status}" and cannot be consumed.` };
	}
	return { ok: true, lot };
}

function generateOutputLot(): string {
	const now = new Date();
	const ds = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	return `LOT-${ds}-${nanoid(4).toUpperCase()}`;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [config, recentLots, parts, ovens] = await Promise.all([
		ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean(),
		LotRecord.find({ 'processConfig.processType': PROCESS_TYPE })
			.sort({ createdAt: -1 }).limit(20).lean(),
		PartDefinition.find({ bomType: 'cartridge', isActive: true }).lean(),
		Equipment.find({
			equipmentType: 'oven',
			status: { $in: ['active', 'available', 'in_use'] }
		}).select('_id name barcode status').lean()
	]);

	if (!config) {
		return {
			config: null,
			availableLots: { 'PT-CT-104': [], 'PT-CT-112': [], 'PT-CT-106': [] },
			processSteps: [],
			lotStepEntries: [],
			recentLots: [],
			ovens: [],
			inventory: {
				rawCartridges: { name: 'Cartridges', quantity: 0, unit: 'pcs' },
				barcodeLabels: { name: 'Barcodes', quantity: 0, unit: 'pcs' },
				individualBacks: { name: 'Laser Cut Backs', quantity: 0, unit: 'pcs' },
				cutThermosealStrips: { name: 'Thermoseal Laser Cut Sheets', quantity: 0, unit: 'pcs' }
			},
			error: 'No backing process configuration found'
		};
	}

	const c = config as any;
	const partByPN = new Map((parts as any[]).map((p: any) => [p.partNumber, p]));
	const partQty = (pn: string) => (partByPN.get(pn) as any)?.inventoryCount ?? 0;

	// Available input lots per consumed part, for the batch-setup dropdowns.
	// remaining = lot.quantity − Σ(consumption/scrap tx against that lotId).
	const consumedPNs = CONSUMED_PARTS.map((p) => p.partNumber);
	const recvLots = await ReceivingLot.find({
		'part.partNumber': { $in: consumedPNs },
		status: { $nin: ['rejected', 'returned'] }
	}).select('lotId part.partNumber quantity').lean() as any[];
	const consumedAgg = await InventoryTransaction.aggregate([
		{ $match: { lotId: { $in: recvLots.map((l) => l.lotId) }, transactionType: { $in: ['consumption', 'scrap'] } } },
		{ $group: { _id: '$lotId', total: { $sum: '$quantity' } } }
	]);
	const consumedByLot = new Map((consumedAgg as any[]).map((c2: any) => [c2._id, Math.abs(c2.total ?? 0)]));
	const availableLots: Record<string, { lotId: string; quantity: number; remaining: number }[]> = {
		'PT-CT-104': [], 'PT-CT-112': [], 'PT-CT-106': []
	};
	for (const l of recvLots) {
		const pn = l.part?.partNumber;
		if (!availableLots[pn]) continue;
		const qty = Number(l.quantity ?? 0);
		const remaining = Math.max(0, qty - (consumedByLot.get(l.lotId) ?? 0));
		if (remaining > 0) availableLots[pn].push({ lotId: l.lotId, quantity: qty, remaining });
	}
	for (const pn of consumedPNs) availableLots[pn].sort((a, b) => b.remaining - a.remaining);

	return {
		availableLots,
		config: {
			configId: String(c._id),
			processName: c.processName ?? 'Cartridge Backing (WI-01)',
			maxBatchSize: c.maxBatchSize ?? 100,
			handoffPrompt: c.handoffPrompt ?? 'Backed cartridges ready for wax filling.',
			inputMaterials: (c.inputMaterials ?? []).map((m: any, i: number) => ({
				partId: m.partDefinitionId ?? '',
				name: m.name ?? `Input ${i + 1}`,
				scanOrder: m.scanOrder ?? i + 1
			}))
		},
		processSteps: [],
		lotStepEntries: [],
		recentLots: (recentLots as any[]).map((l: any) => ({
			lotId: String(l._id),
			bucketBarcode: l.bucketBarcode ?? null,
			outputLotNumber: l.outputLotNumber ?? null,
			quantityProduced: l.quantityProduced ?? 0,
			operatorName: l.operator?.username ?? 'unknown',
			status: l.status ?? 'unknown',
			createdAt: l.createdAt?.toISOString?.() ?? '',
			finishTime: l.finishTime?.toISOString?.() ?? null
		})),
		ovens: (ovens as any[]).map((o: any) => ({
			_id: String(o._id),
			name: o.name ?? '',
			barcode: o.barcode ?? '',
			status: o.status ?? ''
		})),
		inventory: {
			rawCartridges: { name: 'Cartridges', quantity: partQty('PT-CT-104'), unit: 'pcs' },
			barcodeLabels: { name: 'Barcodes', quantity: partQty('PT-CT-106'), unit: 'pcs' },
			individualBacks: { name: 'Laser Cut Backs', quantity: partQty('PT-CT-112'), unit: 'pcs' },
			cutThermosealStrips: { name: 'Thermoseal Laser Cut Sheets', quantity: partQty('PT-CT-112'), unit: 'pcs' }
		}
	};
};

export const actions: Actions = {
	/**
	 * Validate a single scanned lot barcode against the part it should
	 * belong to. Called inline from the scan step so a mis-scan never
	 * reaches checkAndStart.
	 */
	validateLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() ?? '';
		const partNumber = (data.get('partNumber') as string)?.trim() ?? '';
		const check = await validateLotForPart(lotId, partNumber);
		if (!check.ok) {
			return fail(400, { validateLot: { ok: false, partNumber, lotId, reason: check.reason } });
		}

		// Per-lot remaining = lot.quantity - sum of consumption/scrap transactions
		// against this lotId. Without this, the inventory cards above show the
		// part-total (e.g. 1550 across all PT-CT-104 lots) and the operator has
		// no way to tell whether THIS lot can cover their planned batch.
		// Aggregating raw quantity field with Math.abs handles both sign
		// conventions historically used by recordTransaction.
		const consumed = await InventoryTransaction.aggregate([
			{ $match: { lotId, transactionType: { $in: ['consumption', 'scrap'] } } },
			{ $group: { _id: null, total: { $sum: '$quantity' } } }
		]);
		const consumedAbs = Math.abs((consumed[0] as any)?.total ?? 0);
		const lotQty = Number(check.lot.quantity ?? 0);
		const lotRemaining = Math.max(0, lotQty - consumedAbs);

		return {
			validateLot: {
				ok: true,
				partNumber,
				lotId,
				partName: check.lot.part?.name ?? '',
				lotQuantity: lotQty,
				lotConsumed: consumedAbs,
				lotRemaining
			}
		};
	},

	/**
	 * Check inventory for the requested quantity, create lot, and start batch.
	 * Validates that all 3 materials have enough stock before proceeding.
	 */
	checkAndStart: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		// quantity is OPTIONAL (oven-session flow): the real count is reconciled
		// from cartridges actually scanned into the oven at confirmComplete. When
		// 0/absent we skip the upfront inventory precheck.
		const quantity = Number(data.get('quantity') || 0);
		const lot1 = (data.get('lot1') as string)?.trim() || '';
		const lot2 = (data.get('lot2') as string)?.trim() || '';
		const lot3 = (data.get('lot3') as string)?.trim() || '';
		const ovenId = (data.get('ovenId') as string)?.trim() || '';

		// Oven is chosen once at setup and stored on the lot so the scan session
		// (and any later resume) never re-asks for it (WI01-BACKING-FLOW-FIXES).
		if (!ovenId) return fail(400, { checkAndStart: { error: 'Select an oven before starting' } });
		const oven = await Equipment.findOne({
			equipmentType: 'oven',
			$or: [{ _id: ovenId }, { barcode: ovenId }]
		}).select('_id name barcode').lean() as any;
		if (!oven) return fail(400, { checkAndStart: { error: `No oven found matching "${ovenId}"` } });

		// Defense-in-depth: re-validate each selected lot matches the part it
		// represents (dropdowns are server-populated, but a forged form submission
		// could still slip through).
		const scanChecks: Array<[string, string, string]> = [
			['PT-CT-104', 'Cartridge', lot1],
			['PT-CT-112', 'Thermoseal Laser Cut Sheet', lot2],
			['PT-CT-106', 'Barcode', lot3]
		];
		for (const [partNumber, label, lotId] of scanChecks) {
			const check = await validateLotForPart(lotId, partNumber);
			if (!check.ok) {
				return fail(400, { checkAndStart: { error: `${label}: ${check.reason}` } });
			}
		}

		// Upfront inventory precheck only when a planned quantity was given.
		if (quantity > 0) {
			const parts = await PartDefinition.find({
				partNumber: { $in: CONSUMED_PARTS.map(p => p.partNumber) },
				bomType: 'cartridge',
				isActive: true
			}).lean() as any[];

			const partMap = new Map(parts.map((p: any) => [p.partNumber, p]));
			const insufficient: { name: string; need: number; have: number }[] = [];

			for (const cp of CONSUMED_PARTS) {
				const part = partMap.get(cp.partNumber);
				const have = part?.inventoryCount ?? 0;
				if (have < quantity) {
					insufficient.push({ name: cp.name, need: quantity, have });
				}
			}

			if (insufficient.length > 0) {
				return fail(400, {
					checkAndStart: {
						error: 'Insufficient inventory for this batch size',
						insufficient
					}
				});
			}
		}

		// Create lot record with auto-generated QR
		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		const lotId = generateId();
		const qrCodeRef = `WI01-${nanoid(8).toUpperCase()}`;
		const outputLotNumber = generateOutputLot();

		const inputLots = [
			{ materialName: 'Cartridge', barcode: lot1, scanOrder: 1, scannedAt: new Date() },
			{ materialName: 'Thermoseal Laser Cut Sheet', barcode: lot2, scanOrder: 2, scannedAt: new Date() },
			{ materialName: 'Barcode', barcode: lot3, scanOrder: 3, scannedAt: new Date() }
		].filter(l => l.barcode);

		await LotRecord.create({
			_id: lotId,
			qrCodeRef,
			outputLotNumber,
			processConfig: config ? {
				_id: config._id,
				processName: config.processName,
				processType: config.processType
			} : undefined,
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'In Progress',
			startTime: new Date(),
			inputLots,
			backingOven: { ovenId: String(oven._id), ovenName: oven.name ?? oven.barcode ?? '' },
			plannedQuantity: quantity,
			stepEntries: [],
			cartridgeIds: []
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date(),
			newData: { quantity, inputLots: inputLots.map(l => l.barcode) }
		});

		return { checkAndStart: { success: true, lotId, plannedQty: quantity } };
	},

	/**
	 * Scan one backed cartridge into the oven (WAX-FLOW-2). This is the point
	 * of individuation: the scan originates the CartridgeRecord with status
	 * 'backing', full material lineage from the parent LotRecord, and the oven
	 * entry timestamp. Replaces the retired BackingLot aggregate.
	 */
	scanBackedCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() || '';
		const barcode = (data.get('barcode') as string)?.trim() || '';
		const ovenId = (data.get('ovenId') as string)?.trim() || '';

		if (!lotId) return fail(400, { scanBackedCartridge: { error: 'Lot ID required' } });
		if (!barcode) return fail(400, { scanBackedCartridge: { error: 'Cartridge barcode required' } });
		if (!ovenId) return fail(400, { scanBackedCartridge: { error: 'Select an oven before scanning' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { scanBackedCartridge: { error: 'Lot not found' } });
		if (lot.status !== 'In Progress') {
			return fail(400, { scanBackedCartridge: { error: `Lot is "${lot.status}" — only In Progress lots accept scans` } });
		}

		const oven = await Equipment.findOne({
			equipmentType: 'oven',
			$or: [{ _id: ovenId }, { barcode: ovenId }]
		}).select('_id name barcode').lean() as any;
		if (!oven) return fail(400, { scanBackedCartridge: { error: `No oven found matching "${ovenId}"` } });

		// Backing is the GENESIS of every cartridge record — a barcode may only be
		// born once. Reject if a CartridgeRecord with this barcode already exists
		// at ANY status (WI01-BACKING-FLOW-FIXES change 3).
		const existing = await CartridgeRecord.findById(barcode).select('status').lean() as any;
		if (existing) {
			return fail(409, { scanBackedCartridge: { error: `Cartridge ${barcode} already exists in the system (status "${existing.status}"). Backing must be the first record for a barcode — this one is already in use.`, barcode } });
		}

		// Material lineage from the parent LotRecord's input scans
		const lotByMaterial: Record<string, string | undefined> = {};
		for (const il of (lot.inputLots ?? []) as Array<{ materialName?: string; barcode?: string }>) {
			if (il?.materialName && il?.barcode) lotByMaterial[il.materialName] = il.barcode;
		}

		const now = new Date();
		await CartridgeRecord.create({
			_id: barcode,
			status: 'backing',
			backing: {
				parentLotRecordId: lotId,
				lotQrCode: lot.qrCodeRef ?? null,
				cartridgeBlankLot: lotByMaterial['Cartridge'] ?? null,
				thermosealLot: lotByMaterial['Thermoseal Laser Cut Sheet'] ?? null,
				barcodeLabelLot: lotByMaterial['Barcode'] ?? null,
				ovenEntryTime: now,
				ovenLocationId: String(oven._id),
				ovenLocationName: oven.name ?? oven.barcode ?? '',
				operator: { _id: locals.user._id, username: locals.user.username },
				recordedAt: now
			}
		});

		await LotRecord.findByIdAndUpdate(lotId, { $addToSet: { cartridgeIds: barcode } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: barcode,
			action: 'INSERT',
			changedBy: locals.user.username,
			changedAt: now,
			newData: { status: 'backing', parentLotRecordId: lotId, ovenLocationId: String(oven._id) }
		});

		const updated = await LotRecord.findById(lotId).select('cartridgeIds').lean() as any;
		return {
			scanBackedCartridge: {
				success: true,
				barcode,
				ovenName: oven.name ?? '',
				scannedCount: updated?.cartridgeIds?.length ?? 0
			}
		};
	},

	/**
	 * Undo a mis-scan before the batch is confirmed: deletes the just-created
	 * 'backing' CartridgeRecord and pulls it off the LotRecord.
	 */
	removeBackedCartridge: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = (data.get('lotId') as string)?.trim() || '';
		const barcode = (data.get('barcode') as string)?.trim() || '';
		if (!lotId || !barcode) return fail(400, { removeBackedCartridge: { error: 'Lot ID and barcode required' } });

		const cart = await CartridgeRecord.findById(barcode).select('status backing.parentLotRecordId').lean() as any;
		if (!cart) return fail(404, { removeBackedCartridge: { error: 'Cartridge not found' } });
		if (cart.status !== 'backing' || cart.backing?.parentLotRecordId !== lotId) {
			return fail(400, { removeBackedCartridge: { error: 'Cartridge is not an unconfirmed scan of this lot' } });
		}

		await CartridgeRecord.deleteOne({ _id: barcode });
		await LotRecord.findByIdAndUpdate(lotId, { $pull: { cartridgeIds: barcode } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_records',
			recordId: barcode,
			action: 'DELETE',
			changedBy: locals.user.username,
			changedAt: new Date(),
			oldData: { status: 'backing', parentLotRecordId: lotId },
			reason: 'Operator removed mis-scanned cartridge before batch confirm'
		});

		return { removeBackedCartridge: { success: true, barcode } };
	},

	/**
	 * Confirm batch completion + withdraw all 3 materials. Each cartridge
	 * consumes 1x Cartridge, 1x Thermoseal, 1x Barcode. The good count is the
	 * number of cartridges actually scanned into the oven (WAX-FLOW-2) — no
	 * aggregate BackingLot is created any more.
	 */
	confirmComplete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const scrapCartridge = Number(data.get('scrapCartridge') || 0);
		const scrapThermoseal = Number(data.get('scrapThermoseal') || 0);
		const scrapBarcode = Number(data.get('scrapBarcode') || 0);
		const scrapReason = (data.get('scrapReason') as string)?.trim() || '';
		const notes = (data.get('notes') as string)?.trim() || '';

		const totalScrap = scrapCartridge + scrapThermoseal + scrapBarcode;

		if (!lotId) return fail(400, { confirmComplete: { error: 'Lot ID required' } });
		if (totalScrap > 0 && !scrapReason) {
			return fail(400, { confirmComplete: { error: 'Scrap reason is required when any parts are scrapped' } });
		}

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { confirmComplete: { error: 'Lot not found' } });
		if (lot.status === 'Completed') {
			// Idempotency: a double-submit (e.g. SvelteKit action fetch retried)
			// would otherwise produce duplicate consumption + scrap transactions.
			// See inventory-transactions audit trail for the 2026-04-13
			// KnvhBjHKSC0jStX1rQw4s lot that was superseded for this reason.
			return fail(409, { confirmComplete: { error: 'Lot already completed' } });
		}

		// Good count = cartridges actually scanned into the oven. The scans are
		// the source of truth — no manually-entered count, no bucket aggregate.
		const actualCount = (lot.cartridgeIds ?? []).length;
		if (actualCount <= 0) {
			return fail(400, { confirmComplete: { error: 'No cartridges scanned — scan each backed cartridge into the oven first' } });
		}

		// Oven for the lot-level placement record: taken from the scanned
		// cartridges (they all carry backing.ovenLocationId from the scan step).
		const firstCart = await CartridgeRecord.findById(lot.cartridgeIds[0])
			.select('backing.ovenLocationId backing.ovenLocationName').lean() as any;
		const ovenId = firstCart?.backing?.ovenLocationId ?? null;
		const ovenName = firstCart?.backing?.ovenLocationName ?? '';

		const now = new Date();
		const startTime = lot.startTime ?? now;
		const cycleTime = Math.round((now.getTime() - startTime.getTime()) / 1000);

		// Per-part scrap counts: each material consumed = good + its scrap
		const perPartScrap: Record<string, number> = {
			'PT-CT-104': scrapCartridge,
			'PT-CT-112': scrapThermoseal,
			'PT-CT-106': scrapBarcode
		};

		// Each cartridge was already individuated as a CartridgeRecord
		// (status 'backing') by scanBackedCartridge — no BackingLot aggregate
		// is created any more (WAX-FLOW-2).

		// Finalize lot. cartridgeIds was populated scan-by-scan.
		await LotRecord.findByIdAndUpdate(lotId, {
			$set: {
				status: 'Completed',
				finishTime: now,
				cycleTime,
				quantityProduced: actualCount,
				scrapCount: totalScrap,
				scrapDetail: { cartridge: scrapCartridge, thermoseal: scrapThermoseal, barcode: scrapBarcode },
				scrapReason: scrapReason || undefined,
				ovenEntryTime: now,
				...(ovenId ? {
					ovenPlacement: {
						ovenId,
						ovenBarcode: ovenName,
						placedAt: now,
						placedBy: { _id: locals.user._id, username: locals.user.username }
					}
				} : {}),
				notes: notes || undefined
			}
		});

		// Build a materialName → input ReceivingLot barcode map from the
		// LotRecord we created at checkAndStart. Each consumption / scrap tx
		// gets the actual input lot stamped on it so per-lot remaining math
		// works AND the inventory-transactions UI can show "consumed from
		// lot X." Until this fix, lotId was never written and per-lot
		// remaining always equaled the original lot quantity.
		const inputLotByMaterial: Record<string, string | undefined> = {};
		for (const il of (lot.inputLots ?? []) as Array<{ materialName?: string; barcode?: string }>) {
			if (il?.materialName && il?.barcode) inputLotByMaterial[il.materialName] = il.barcode;
		}

		// Withdraw each material: good count + that part's specific scrap
		for (const cp of CONSUMED_PARTS) {
			const partScrap = perPartScrap[cp.partNumber] ?? 0;
			const consumed = actualCount + partScrap;
			const partId = await resolvePartId(cp.partNumber);
			const inputLotBarcode = inputLotByMaterial[cp.name];

			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: partId ?? undefined,
				lotId: inputLotBarcode,
				quantity: consumed,
				manufacturingStep: 'backing',
				manufacturingRunId: lotId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				notes: `WI-01 lot ${lotId}: ${consumed}x ${cp.name} (${actualCount} good + ${partScrap} scrapped) from input lot ${inputLotBarcode ?? '(unknown)'}`
			});

			// Separate scrap transaction for this part if any were scrapped
			if (partScrap > 0) {
				await recordTransaction({
					transactionType: 'scrap',
					partDefinitionId: partId ?? undefined,
					lotId: inputLotBarcode,
					quantity: partScrap,
					manufacturingStep: 'backing',
					manufacturingRunId: lotId,
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					scrapReason,
					scrapCategory: 'other',
					notes: `WI-01 lot ${lotId}: ${partScrap}x ${cp.name} scrapped from input lot ${inputLotBarcode ?? '(unknown)'} — ${scrapReason}`
				});
			}
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date(),
			newData: {
				actualCount,
				cartridgeIds: lot.cartridgeIds ?? [],
				scrapDetail: { cartridge: scrapCartridge, thermoseal: scrapThermoseal, barcode: scrapBarcode },
				scrapReason: scrapReason || undefined,
				ovenId: ovenId || undefined,
				notes: notes || undefined,
				materialsConsumed: CONSUMED_PARTS.map(p => p.partNumber)
			}
		});

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		return {
			confirmComplete: {
				success: true,
				handoffPrompt: config?.handoffPrompt ?? 'Backed cartridges ready for wax filling.'
			}
		};
	},

	/** Append a timestamped note to an in-progress lot */
	addSessionNote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const note = (data.get('note') as string)?.trim() || '';

		if (!lotId) return fail(400, { addSessionNote: { error: 'Lot ID required' } });
		if (!note) return fail(400, { addSessionNote: { error: 'Note text is required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { addSessionNote: { error: 'Lot not found' } });

		const timestamp = new Date().toISOString();
		const entry = `[${timestamp}] (${locals.user.username}) ${note}`;
		const updatedNotes = lot.notes ? `${lot.notes}\n${entry}` : entry;

		await LotRecord.findByIdAndUpdate(lotId, { $set: { notes: updatedNotes } });

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date(),
			newData: { noteAdded: entry }
		});

		return { addSessionNote: { success: true, notes: updatedNotes } };
	},

	/**
	 * Delete an in-progress lot. Only allowed when status='In Progress' —
	 * completed lots are immutable (consumed inventory, registered BackingLot).
	 * No inventory was withdrawn yet at the In Progress stage (withdrawal
	 * happens in confirmComplete), so deletion just removes the LotRecord
	 * stub and audit-logs the discard.
	 */
	deleteLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { deleteLot: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { deleteLot: { error: 'Lot not found' } });
		if (lot.status !== 'In Progress') {
			return fail(400, { deleteLot: { error: `Cannot delete lot in status "${lot.status}". Only In Progress lots can be deleted.` } });
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'DELETE',
			changedBy: locals.user.username,
			changedAt: new Date(),
			oldData: {
				status: lot.status,
				plannedQuantity: lot.plannedQuantity,
				operator: lot.operator,
				inputLots: (lot.inputLots ?? []).map((l: any) => ({ materialName: l.materialName, barcode: l.barcode })),
				startTime: lot.startTime
			},
			reason: 'Operator-initiated discard of in-progress backing batch'
		});

		await LotRecord.deleteOne({ _id: lotId });

		return { deleteLot: { success: true, lotId } };
	},

	/** Resume an in-progress lot */
	resumeLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { resumeLot: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { resumeLot: { error: 'Lot not found' } });

		// Recover the batch oven so the resumed session shows it locked instead
		// of re-asking (WI01-BACKING-FLOW-FIXES). Prefer the oven stored at
		// setup; for legacy lots without it, derive from the first scanned cart.
		let ovenId: string = lot.backingOven?.ovenId ?? '';
		let ovenName: string = lot.backingOven?.ovenName ?? '';
		if (!ovenId && (lot.cartridgeIds ?? []).length > 0) {
			const firstCart = await CartridgeRecord.findById(lot.cartridgeIds[0])
				.select('backing.ovenLocationId backing.ovenLocationName').lean() as any;
			ovenId = firstCart?.backing?.ovenLocationId ?? '';
			ovenName = firstCart?.backing?.ovenLocationName ?? '';
		}

		return {
			resumeLot: {
				success: true,
				lotId,
				resumeStep: 'working',
				plannedQty: lot.plannedQuantity ?? 1,
				ovenId,
				ovenName,
				// Re-hydrate the oven-scan list so already-scanned cartridges
				// survive a page reload mid-batch (WAX-FLOW-2)
				cartridgeIds: lot.cartridgeIds ?? []
			}
		};
	}
};

export const config = { maxDuration: 60 };
