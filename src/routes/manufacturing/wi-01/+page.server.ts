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
	connectDB, LotRecord, ProcessConfiguration, CartridgeRecord,
	PartDefinition, AuditLog, generateId
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

function generateOutputLot(): string {
	const now = new Date();
	const ds = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	return `LOT-${ds}-${nanoid(4).toUpperCase()}`;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [config, recentLots, parts] = await Promise.all([
		ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean(),
		LotRecord.find({ 'processConfig.processType': PROCESS_TYPE })
			.sort({ createdAt: -1 }).limit(20).lean(),
		PartDefinition.find({ bomType: 'cartridge', isActive: true }).lean()
	]);

	if (!config) {
		return {
			config: null,
			processSteps: [],
			lotStepEntries: [],
			recentLots: [],
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

	return {
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
			quantityProduced: l.quantityProduced ?? 0,
			operatorName: l.operator?.username ?? 'unknown',
			status: l.status ?? 'unknown',
			createdAt: l.createdAt?.toISOString?.() ?? '',
			finishTime: l.finishTime?.toISOString?.() ?? null
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
	 * Check inventory for the requested quantity, create lot, and start batch.
	 * Validates that all 3 materials have enough stock before proceeding.
	 */
	checkAndStart: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const quantity = Number(data.get('quantity') || 0);
		const lot1 = (data.get('lot1') as string)?.trim() || '';
		const lot2 = (data.get('lot2') as string)?.trim() || '';
		const lot3 = (data.get('lot3') as string)?.trim() || '';

		if (quantity <= 0) return fail(400, { checkAndStart: { error: 'Quantity must be greater than 0' } });

		// Check inventory for all 3 consumed materials
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
	 * Confirm batch completion: create CartridgeRecords + withdraw all 3 materials.
	 * Each cartridge consumes 1x Cartridge, 1x Thermoseal, 1x Barcode.
	 */
	confirmComplete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const actualCount = Number(data.get('actualCount') || 0);
		const scrapCount = Number(data.get('scrapCount') || 0);
		const scrapReason = (data.get('scrapReason') as string)?.trim() || '';
		const bucketBarcode = (data.get('bucketBarcode') as string)?.trim() || '';
		const notes = (data.get('notes') as string)?.trim() || '';

		if (!lotId) return fail(400, { confirmComplete: { error: 'Lot ID required' } });
		if (actualCount <= 0) return fail(400, { confirmComplete: { error: 'Count must be greater than 0' } });
		if (scrapCount > 0 && !scrapReason) {
			return fail(400, { confirmComplete: { error: 'Scrap reason is required when scrap count > 0' } });
		}

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { confirmComplete: { error: 'Lot not found' } });

		const now = new Date();
		const startTime = lot.startTime ?? now;
		const cycleTime = Math.round((now.getTime() - startTime.getTime()) / 1000);
		const totalConsumed = actualCount + scrapCount;

		// Create CartridgeRecords (only for good units)
		const cartridgeIds: string[] = [];
		const cartridgeDocs = [];
		for (let i = 0; i < actualCount; i++) {
			const cid = generateId();
			cartridgeIds.push(cid);
			cartridgeDocs.push({
				_id: cid,
				backing: {
					lotId,
					lotQrCode: lot.qrCodeRef,
					operator: { _id: locals.user._id, username: locals.user.username },
					recordedAt: now
				},
				status: 'backing',
				createdAt: now,
				updatedAt: now
			});
		}
		if (cartridgeDocs.length > 0) {
			await CartridgeRecord.insertMany(cartridgeDocs);
		}

		// Finalize lot
		await LotRecord.findByIdAndUpdate(lotId, {
			$set: {
				status: 'Completed',
				finishTime: now,
				cycleTime,
				quantityProduced: actualCount,
				cartridgeIds,
				scrapCount,
				scrapReason: scrapReason || undefined,
				bucketBarcode: bucketBarcode || undefined,
				notes: notes || undefined
			}
		});

		// Withdraw all 3 materials — totalConsumed = good + scrapped
		for (const cp of CONSUMED_PARTS) {
			const partId = await resolvePartId(cp.partNumber);
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: partId ?? undefined,
				quantity: totalConsumed,
				manufacturingStep: 'backing',
				manufacturingRunId: lotId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				notes: `WI-01 Backing lot ${lotId}: ${totalConsumed}x ${cp.name} consumed (${actualCount} good + ${scrapCount} scrapped)`
			});

			// Record separate scrap transaction if there were scrapped units
			if (scrapCount > 0) {
				await recordTransaction({
					transactionType: 'scrap',
					partDefinitionId: partId ?? undefined,
					quantity: scrapCount,
					manufacturingStep: 'backing',
					manufacturingRunId: lotId,
					operatorId: locals.user._id,
					operatorUsername: locals.user.username,
					scrapReason,
					scrapCategory: 'other',
					notes: `WI-01 Backing lot ${lotId}: ${scrapCount}x ${cp.name} scrapped — ${scrapReason}`
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
				scrapCount,
				scrapReason: scrapReason || undefined,
				bucketBarcode: bucketBarcode || undefined,
				notes: notes || undefined,
				materialsConsumed: CONSUMED_PARTS.map(p => p.partNumber),
				totalConsumed
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

	/** Resume an in-progress lot */
	resumeLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { resumeLot: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { resumeLot: { error: 'Lot not found' } });

		return {
			resumeLot: {
				success: true,
				lotId,
				resumeStep: 'working',
				plannedQty: lot.plannedQuantity ?? 1
			}
		};
	}
};

export const config = { maxDuration: 60 };
