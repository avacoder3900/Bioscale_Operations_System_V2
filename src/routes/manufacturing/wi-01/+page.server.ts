/**
 * WI-01: Cartridge Backing
 * Lot traceability: Input lots (raw cartridge, laser-cut back, barcode label)
 * → Output lot (LotRecord.qrCodeRef) → CartridgeRecord.backing.lotId
 * ISO 13485: input lot → output lot → cartridge IDs fully linked
 */
import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, LotRecord, ProcessConfiguration, CartridgeRecord,
	ManufacturingMaterial, ManufacturingMaterialTransaction,
	PartDefinition, AuditLog, generateId
} from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

const PROCESS_TYPE = 'backing';

function generateOutputLot(): string {
	const now = new Date();
	const ds = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
	return `LOT-${ds}-${nanoid(4).toUpperCase()}`;
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [config, recentLots, materials, parts] = await Promise.all([
		ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean(),
		LotRecord.find({ 'processConfig.processType': PROCESS_TYPE })
			.sort({ createdAt: -1 }).limit(20).lean(),
		ManufacturingMaterial.find().lean(),
		PartDefinition.find({ bomType: 'cartridge', isActive: true }).lean()
	]);

	if (!config) {
		return {
			config: null,
			processSteps: [],
			lotStepEntries: [],
			recentLots: [],
			inventory: {
				rawCartridges: { name: 'Raw Cartridges', quantity: 0, unit: 'pcs' },
				barcodeLabels: { name: 'Barcode Labels', quantity: 0, unit: 'pcs' },
				individualBacks: { name: 'Laser Cut Backs', quantity: 0, unit: 'pcs' }
			},
			error: 'No backing process configuration found'
		};
	}

	const c = config as any;
	const matMap = new Map((materials as any[]).map((m: any) => [m.name?.toLowerCase(), m]));
	const partMap = new Map((parts as any[]).map((p: any) => [p.name?.toLowerCase(), p]));

	const findQty = (regex: RegExp) => {
		for (const [k, v] of matMap) if (regex.test(k)) return (v as any).currentQuantity ?? 0;
		for (const [k, v] of partMap) if (regex.test(k)) return (v as any).inventoryCount ?? 0;
		return 0;
	};

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
		processSteps: (c.steps ?? []).map((s: any) => ({
			id: String(s._id),
			configId: String(c._id),
			stepNumber: s.stepNumber ?? 0,
			title: s.title ?? '',
			description: s.description ?? null,
			imageUrl: s.imageUrl ?? null
		})),
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
			rawCartridges: { name: 'Raw Cartridges', quantity: findQty(/raw.?cartridge|cartridge.?body/i), unit: 'pcs' },
			barcodeLabels: { name: 'Barcode Labels', quantity: findQty(/barcode.?label|label/i), unit: 'pcs' },
			individualBacks: { name: 'Laser Cut Backs', quantity: findQty(/laser.?cut|cut.?sub|substrate/i), unit: 'pcs' }
		}
	};
};

export const actions: Actions = {
	/** Step 1: Bind output QR code → creates LotRecord with auto-generated output lot */
	bindQR: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const qrCodeRef = (data.get('qrCodeRef') as string)?.trim();
		if (!qrCodeRef) return fail(400, { bindQR: { error: 'QR code required' } });

		const existing = await LotRecord.findOne({ qrCodeRef }).lean() as any;
		if (existing) {
			// Resume in-progress lot
			if (existing.status === 'In Progress') {
				return { bindQR: { success: true, lotId: String(existing._id) } };
			}
			return fail(400, { bindQR: { error: 'QR code already used for a completed lot' } });
		}

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		const lotId = generateId();
		const outputLotNumber = generateOutputLot();

		await LotRecord.create({
			_id: lotId,
			qrCodeRef,
			outputLotNumber,       // denormalized for quick lookup
			processConfig: config ? {
				_id: config._id,
				processName: config.processName,
				processType: config.processType
			} : undefined,
			operator: { _id: locals.user._id, username: locals.user.username },
			status: 'In Progress',
			startTime: new Date(),
			stepEntries: [],
			cartridgeIds: []
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'INSERT',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});

		return { bindQR: { success: true, lotId, outputLotNumber } };
	},

	/** Step 2: Record input lot barcodes (raw cartridge lot, laser-cut back lot, barcode label lot) */
	setInputLots: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { setInputLots: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { setInputLots: { error: 'Lot not found' } });

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		const inputMaterials = config?.inputMaterials ?? [];

		const inputLots = [];
		for (let i = 0; i < 3; i++) {
			const barcode = (data.get(`input${i + 1}`) as string)?.trim();
			if (barcode) {
				inputLots.push({
					materialName: inputMaterials[i]?.name ?? `Input ${i + 1}`,
					barcode,
					partDefinitionId: inputMaterials[i]?.partDefinitionId ?? undefined,
					scanOrder: i + 1,
					scannedAt: new Date()
				});
			}
		}

		await LotRecord.findByIdAndUpdate(lotId, {
			$set: { inputLots, updatedAt: new Date() }
		});

		return { setInputLots: { success: true } };
	},

	/** Step 3: Mark batch as started */
	startBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { startBatch: { error: 'Lot ID required' } });

		await LotRecord.findByIdAndUpdate(lotId, {
			$set: { status: 'In Progress', startTime: new Date() }
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});

		return { startBatch: { success: true } };
	},

	/** Step 4: Finish batch — create CartridgeRecords, link to lot, update inventory */
	finishBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const quantity = Number(data.get('quantity') || 0);

		if (!lotId) return fail(400, { finishBatch: { error: 'Lot ID required' } });
		if (quantity <= 0) return fail(400, { finishBatch: { error: 'Quantity must be > 0' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { finishBatch: { error: 'Lot not found' } });

		const now = new Date();
		const startTime = lot.startTime ?? now;
		const cycleTime = Math.round((now.getTime() - startTime.getTime()) / 1000);

		// Create CartridgeRecords for each unit produced, linking backing lot
		const cartridgeIds: string[] = [];
		const cartridgeDocs = [];
		for (let i = 0; i < quantity; i++) {
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
				currentPhase: 'backing',
				createdAt: now,
				updatedAt: now
			});
		}
		if (cartridgeDocs.length > 0) {
			await CartridgeRecord.insertMany(cartridgeDocs);
		}

		// Finalize the lot record
		await LotRecord.findByIdAndUpdate(lotId, {
			$set: {
				status: 'Completed',
				finishTime: now,
				cycleTime,
				quantityProduced: quantity,
				cartridgeIds
			}
		});

		// Consume cartridges (PT-CT-104) from inventory
		const cartridgePartId = await resolvePartId('PT-CT-104');
		await recordTransaction({
			transactionType: 'consumption',
			partDefinitionId: cartridgePartId ?? undefined,
			quantity,
			manufacturingStep: 'backing',
			manufacturingRunId: lotId,
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			notes: `WI-01 Backing lot ${lotId}: ${quantity} cartridges backed`
		});

		await AuditLog.create({
			_id: generateId(),
			tableName: 'lot_records',
			recordId: lotId,
			action: 'UPDATE',
			changedBy: locals.user?.username,
			changedAt: new Date()
		});

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		return {
			finishBatch: {
				success: true,
				lotId,
				handoffPrompt: config?.handoffPrompt ?? 'Backed cartridges ready for wax filling.'
			}
		};
	},

	/** Add a step note / photo to the current lot */
	addNote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const stepId = data.get('stepId') as string;
		const note = (data.get('note') as string) || undefined;

		if (!lotId) return fail(400, { addNote: { error: 'Lot ID required' } });

		const entry = {
			_id: generateId(),
			stepId: stepId || undefined,
			note,
			operator: { _id: locals.user._id, username: locals.user.username },
			completedAt: new Date()
		};

		const updated = await LotRecord.findByIdAndUpdate(
			lotId,
			{ $push: { stepEntries: entry } },
			{ new: true }
		).lean() as any;

		const entries = (updated?.stepEntries ?? []).map((e: any) => ({
			id: String(e._id),
			lotId,
			stepId: e.stepId ?? null,
			note: e.note ?? null,
			imageUrl: e.imageUrl ?? null,
			operatorId: e.operator?._id ?? '',
			operatorName: e.operator?.username ?? '',
			createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
		}));

		return { addNote: { success: true, entries } };
	},

	/** Load existing step entries for a lot (resume flow) */
	loadEntries: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { loadEntries: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		const entries = (lot?.stepEntries ?? []).map((e: any) => ({
			id: String(e._id),
			lotId,
			stepId: e.stepId ?? null,
			note: e.note ?? null,
			imageUrl: e.imageUrl ?? null,
			operatorId: e.operator?._id ?? '',
			operatorName: e.operator?.username ?? '',
			createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
		}));

		return { loadEntries: { success: true, entries } };
	},

	/** Add batch-level note */
	addBatchNote: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		const note = (data.get('note') as string) || undefined;

		if (!lotId) return fail(400, { addBatchNote: { error: 'Lot ID required' } });

		const entry = {
			_id: generateId(),
			stepId: null,
			note,
			operator: { _id: locals.user._id, username: locals.user.username },
			completedAt: new Date()
		};

		const updated = await LotRecord.findByIdAndUpdate(
			lotId,
			{ $push: { stepEntries: entry } },
			{ new: true }
		).lean() as any;

		const batchNotes = (updated?.stepEntries ?? [])
			.filter((e: any) => !e.stepId)
			.map((e: any) => ({
				id: String(e._id),
				lotId,
				stepId: null,
				note: e.note ?? null,
				imageUrl: e.imageUrl ?? null,
				operatorId: e.operator?._id ?? '',
				operatorName: e.operator?.username ?? '',
				createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
			}));

		return { addBatchNote: { success: true, batchNotes } };
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

		// Determine which step to resume at
		let resumeStep = 'qr';
		if (lot.inputLots?.length > 0 && lot.startTime) resumeStep = 'work';
		else if (lot.inputLots?.length > 0) resumeStep = 'start';
		else resumeStep = 'inputs';

		const entries = (lot.stepEntries ?? []).map((e: any) => ({
			id: String(e._id),
			lotId,
			stepId: e.stepId ?? null,
			note: e.note ?? null,
			imageUrl: e.imageUrl ?? null,
			operatorId: e.operator?._id ?? '',
			operatorName: e.operator?.username ?? '',
			createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
		}));

		return { resumeLot: { success: true, lotId, resumeStep, entries } };
	}
};

export const config = { maxDuration: 60 };
