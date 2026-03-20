/**
 * WI-03: Cut Top Seal
 * Lot traceability: Input lot (top seal roll barcode)
 * → Output lot (LotRecord.qrCodeRef, LOT-YYYYMMDD-XXXX)
 * ISO 13485: top seal roll → cut top seal sheets batch lot
 */
import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, LotRecord, ProcessConfiguration,
	ManufacturingMaterial, PartDefinition, generateId
} from '$lib/server/db';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import { nanoid } from 'nanoid';
import type { PageServerLoad, Actions } from './$types';

const PROCESS_TYPE = 'cut_top_seal';

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
				input: { name: 'Top Seal Roll', quantity: 0, unit: 'rolls' },
				output: { name: 'Cut Top Seal Sheets', quantity: 0, unit: 'sheets' }
			},
			error: 'No cut top seal process configuration found'
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
			processName: c.processName ?? 'Cut Top Seal (WI-03)',
			maxBatchSize: c.maxBatchSize ?? 500,
			handoffPrompt: c.handoffPrompt ?? 'Cut top seal sheets ready for sealing.',
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
			input: { name: 'Top Seal Roll', quantity: findQty(/top.?seal.?roll|rol.?top.?seal/i), unit: 'rolls' },
			output: { name: 'Cut Top Seal Sheets', quantity: findQty(/top.?seal.?sheet|cut.?top.?seal/i), unit: 'sheets' }
		}
	};
};

export const actions: Actions = {
	bindQR: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const qrCodeRef = (data.get('qrCodeRef') as string)?.trim();
		if (!qrCodeRef) return fail(400, { bindQR: { error: 'QR code required' } });

		const existing = await LotRecord.findOne({ qrCodeRef }).lean() as any;
		if (existing) {
			if (existing.status === 'In Progress') return { bindQR: { success: true, lotId: String(existing._id) } };
			return fail(400, { bindQR: { error: 'QR code already used for a completed lot' } });
		}

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		const lotId = generateId();
		const outputLotNumber = generateOutputLot();

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
			stepEntries: [],
			cartridgeIds: []
		});

		return { bindQR: { success: true, lotId, outputLotNumber } };
	},

	/** Record the input lot (top seal roll barcode) */
	setInputLots: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { setInputLots: { error: 'Lot ID required' } });

		const barcode = (data.get('input1') as string)?.trim();
		if (!barcode) return fail(400, { setInputLots: { error: 'Top seal roll lot/barcode required' } });

		const inputLots = [{
			materialName: 'Top Seal Roll',
			barcode,
			scanOrder: 1,
			scannedAt: new Date()
		}];

		await LotRecord.findByIdAndUpdate(lotId, {
			$set: { inputLots, updatedAt: new Date() }
		});

		return { setInputLots: { success: true } };
	},

	startBatch: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { startBatch: { error: 'Lot ID required' } });

		await LotRecord.findByIdAndUpdate(lotId, {
			$set: { status: 'In Progress', startTime: new Date() }
		});

		return { startBatch: { success: true } };
	},

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

		await LotRecord.findByIdAndUpdate(lotId, {
			$set: {
				status: 'Completed',
				finishTime: now,
				cycleTime,
				quantityProduced: quantity
			}
		});

		// Record production of cut top seal sheets
		await recordTransaction({
			transactionType: 'creation',
			quantity,
			manufacturingStep: 'top_seal',
			manufacturingRunId: lotId,
			operatorId: locals.user._id,
			operatorUsername: locals.user.username,
			notes: `WI-03 Cut Top Seal lot ${lotId}: ${quantity} sheets produced from roll ${lot.inputLots?.[0]?.barcode ?? 'unknown'}`
		});

		const config = await ProcessConfiguration.findOne({ processType: PROCESS_TYPE }).lean() as any;
		return {
			finishBatch: {
				success: true,
				lotId,
				handoffPrompt: config?.handoffPrompt ?? 'Cut top seal sheets ready for sealing.'
			}
		};
	},

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
			lotId, { $push: { stepEntries: entry } }, { new: true }
		).lean() as any;

		const entries = (updated?.stepEntries ?? []).map((e: any) => ({
			id: String(e._id), lotId,
			stepId: e.stepId ?? null, note: e.note ?? null, imageUrl: e.imageUrl ?? null,
			operatorId: e.operator?._id ?? '', operatorName: e.operator?.username ?? '',
			createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
		}));

		return { addNote: { success: true, entries } };
	},

	loadEntries: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { loadEntries: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		const entries = (lot?.stepEntries ?? []).map((e: any) => ({
			id: String(e._id), lotId,
			stepId: e.stepId ?? null, note: e.note ?? null, imageUrl: e.imageUrl ?? null,
			operatorId: e.operator?._id ?? '', operatorName: e.operator?.username ?? '',
			createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
		}));

		return { loadEntries: { success: true, entries } };
	},

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
			lotId, { $push: { stepEntries: entry } }, { new: true }
		).lean() as any;

		const batchNotes = (updated?.stepEntries ?? [])
			.filter((e: any) => !e.stepId)
			.map((e: any) => ({
				id: String(e._id), lotId,
				stepId: null, note: e.note ?? null, imageUrl: e.imageUrl ?? null,
				operatorId: e.operator?._id ?? '', operatorName: e.operator?.username ?? '',
				createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
			}));

		return { addBatchNote: { success: true, batchNotes } };
	},

	resumeLot: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotId = data.get('lotId') as string;
		if (!lotId) return fail(400, { resumeLot: { error: 'Lot ID required' } });

		const lot = await LotRecord.findById(lotId).lean() as any;
		if (!lot) return fail(404, { resumeLot: { error: 'Lot not found' } });

		let resumeStep = 'inputs';
		if (lot.inputLots?.length > 0 && lot.startTime) resumeStep = 'work';
		else if (lot.inputLots?.length > 0) resumeStep = 'start';

		const entries = (lot.stepEntries ?? []).map((e: any) => ({
			id: String(e._id), lotId,
			stepId: e.stepId ?? null, note: e.note ?? null, imageUrl: e.imageUrl ?? null,
			operatorId: e.operator?._id ?? '', operatorName: e.operator?.username ?? '',
			createdAt: e.completedAt?.toISOString?.() ?? new Date().toISOString()
		}));

		return { resumeLot: { success: true, lotId, resumeStep, entries } };
	}
};

export const config = { maxDuration: 60 };
