import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, CartridgeRecord, WaxFillingRun, ReagentBatchRecord,
	ManufacturingMaterial, ManufacturingMaterialTransaction,
	ManufacturingSettings, PartDefinition, generateId
} from '$lib/server/db';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// === Pipeline counts ===
	const phaseCounts = await CartridgeRecord.aggregate([
		{ $group: { _id: '$currentPhase', count: { $sum: 1 } } }
	]);
	const phaseMap = new Map<string, number>(phaseCounts.map((p: any) => [p._id ?? 'unknown', p.count]));
	const backedCount = await CartridgeRecord.countDocuments({ 'backing.recordedAt': { $exists: true } });

	const waxStats = await WaxFillingRun.aggregate([
		{ $match: { status: { $in: ['completed', 'Completed'] } } },
		{ $group: { _id: null, totalRuns: { $sum: 1 }, totalCartridges: { $sum: '$cartridgeCount' } } }
	]);
	const waxCompleted = waxStats[0] ?? { totalRuns: 0, totalCartridges: 0 };

	const reagentStats = await ReagentBatchRecord.aggregate([
		{ $match: { status: { $in: ['completed', 'Completed'] } } },
		{ $group: { _id: null, totalRuns: { $sum: 1 }, totalCartridges: { $sum: '$cartridgeCount' } } }
	]);
	const reagentCompleted = reagentStats[0] ?? { totalRuns: 0, totalCartridges: 0 };

	const activeWaxRuns = await WaxFillingRun.countDocuments({
		status: { $nin: ['completed', 'Completed', 'aborted', 'cancelled', 'voided'] }
	});
	const activeReagentRuns = await ReagentBatchRecord.countDocuments({
		status: { $nin: ['completed', 'Completed', 'aborted', 'Aborted', 'cancelled', 'Cancelled', 'voided'] }
	});

	const waxStored = await CartridgeRecord.countDocuments({ currentPhase: 'wax_stored' });
	const reagentStored = await CartridgeRecord.countDocuments({ currentPhase: 'stored' });
	const sealed = await CartridgeRecord.countDocuments({ currentPhase: 'sealed' });
	const voided = await CartridgeRecord.countDocuments({ currentPhase: 'voided' });

	// === Material inventory ===
	const [materials, settingsDoc] = await Promise.all([
		ManufacturingMaterial.find().sort({ name: 1 }).lean(),
		ManufacturingSettings.findById('default').lean()
	]);

	const general = (settingsDoc as any)?.general ?? {};
	const cartridgesPerSheet = general.cartridgesPerLaserCutSheet ?? 13;

	const materialsList = (materials as any[]).map((m: any) => ({
		materialId: m._id,
		name: m.name ?? '',
		unit: m.unit ?? 'pcs',
		currentQuantity: m.currentQuantity ?? 0,
		partDefinitionId: m.partDefinitionId ?? null,
		partNumber: m.partNumber ?? null,
		updatedAt: m.updatedAt ?? m.createdAt ?? new Date().toISOString()
	}));

	const laserCutMaterial = (materials as any[]).find((m: any) =>
		m.name && /laser.?cut|cut.?sub|substrate/i.test(m.name)
	);
	const individualBacks = (laserCutMaterial?.currentQuantity ?? 0) * cartridgesPerSheet;

	// Pipeline stages
	const stages = [
		{
			id: 'cut-thermoseal', name: 'Cut Thermoseal', href: '/spu/manufacturing/wi-02',
			inputs: [{ name: 'Thermoseal Roll', icon: '🧻', count: null as number | null, unit: 'rolls (ROG)' }],
			outputs: [{ name: 'Thermoseal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'cut-topseal', name: 'Cut Top Seal', href: '/spu/manufacturing/wi-03',
			inputs: [{ name: 'Top Seal Roll', icon: '🧻', count: null as number | null, unit: 'rolls (ROG)' }],
			outputs: [{ name: 'Top Seal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'laser', name: 'Laser Cut', href: '/spu/manufacturing/laser-cutting',
			inputs: [{ name: 'Thermoseal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }],
			outputs: [{ name: 'Cartridge Backs', icon: '🔲', count: individualBacks > 0 ? individualBacks : null, unit: 'backs (13/sheet)' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'backing', name: 'Cartridge Back', href: '/spu/manufacturing/wi-01',
			inputs: [
				{ name: 'Cartridge Back (laser cut)', icon: '🔲', count: individualBacks > 0 ? individualBacks : null, unit: 'backs' },
				{ name: 'Raw Cartridge', icon: '📦', count: null as number | null, unit: 'cartridges (ROG)' },
				{ name: 'Barcode Label', icon: '🏷️', count: null as number | null, unit: 'labels' }
			],
			outputs: [{ name: 'Backed Cartridges', icon: '📦', count: backedCount, unit: 'cartridges' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'wax', name: 'Wax Filling', href: '/spu/manufacturing/wax-filling',
			inputs: [
				{ name: 'Backed Cartridges', icon: '📦', count: backedCount, unit: 'cartridges' },
				{ name: 'Wax (source lots)', icon: '🕯️', count: null as number | null, unit: 'tubes' },
				{ name: 'Pipette Tips', icon: '🔬', count: null as number | null, unit: 'tips' }
			],
			outputs: [
				{ name: 'Wax-Filled Cartridges', icon: '🟡', count: (phaseMap.get('wax_stored') ?? 0) + (phaseMap.get('wax_filled') ?? 0), unit: 'cartridges' },
				{ name: 'In Fridge', icon: '❄️', count: waxStored, unit: 'stored' }
			],
			activeRuns: activeWaxRuns, completedRuns: waxCompleted.totalRuns ?? 0
		},
		{
			id: 'reagent', name: 'Reagent Filling', href: '/spu/manufacturing/reagent-filling',
			inputs: [
				{ name: 'Wax-Filled Cartridges', icon: '🟡', count: waxStored, unit: 'available' },
				{ name: 'Reagents (per assay)', icon: '💧', count: null as number | null, unit: 'wells' },
				{ name: 'Pipette Tips', icon: '🔬', count: null as number | null, unit: 'tips' }
			],
			outputs: [
				{ name: 'Reagent-Filled', icon: '🟣', count: reagentStored + sealed, unit: 'cartridges' },
				{ name: 'In Fridge', icon: '❄️', count: reagentStored, unit: 'stored' }
			],
			activeRuns: activeReagentRuns, completedRuns: reagentCompleted.totalRuns ?? 0
		},
		{
			id: 'topseal-apply', name: 'Top Seal Apply', href: '/spu/manufacturing/top-seal-cutting',
			inputs: [
				{ name: 'Reagent-Filled Cartridges', icon: '🟣', count: reagentStored, unit: 'available' },
				{ name: 'Top Seal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }
			],
			outputs: [{ name: 'Sealed Cartridges', icon: '✅', count: sealed, unit: 'cartridges' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'qaqc', name: 'QA/QC', href: '/spu/manufacturing/qa-qc',
			inputs: [{ name: 'Sealed Cartridges', icon: '✅', count: sealed, unit: 'cartridges' }],
			outputs: [
				{ name: 'Released', icon: '🎯', count: null as number | null, unit: 'cartridges' },
				{ name: 'Voided', icon: '🚫', count: voided, unit: 'cartridges' }
			],
			activeRuns: 0, completedRuns: 0
		}
	];

	// Link material counts to pipeline stages where names match
	for (const mat of materialsList) {
		const lname = mat.name.toLowerCase();
		for (const stage of stages) {
			for (const inp of stage.inputs) {
				if (inp.count === null && lname.includes(inp.name.toLowerCase().split('(')[0].trim().toLowerCase().slice(0, 8))) {
					inp.count = mat.currentQuantity;
				}
			}
			for (const out of stage.outputs) {
				if (out.count === null && lname.includes(out.name.toLowerCase().split('(')[0].trim().toLowerCase().slice(0, 8))) {
					out.count = mat.currentQuantity;
				}
			}
		}
	}

	return {
		stages,
		materials: JSON.parse(JSON.stringify(materialsList)),
		derived: { individualBacks, cartridgesPerSheet },
		totals: {
			backed: backedCount,
			waxStored,
			reagentStored,
			sealed,
			voided,
			totalInSystem: backedCount
		}
	};
};

export const actions: Actions = {
	addMaterial: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const name = data.get('name') as string;
		const unit = data.get('unit') as string;
		const partDefinitionId = (data.get('partDefinitionId') as string) || null;
		if (!name) return fail(400, { error: 'Name is required' });
		let partNumber: string | null = null;
		if (partDefinitionId) {
			const part = await PartDefinition.findById(partDefinitionId).lean() as any;
			partNumber = part?.partNumber ?? null;
		}
		await ManufacturingMaterial.create({
			_id: generateId(), name, unit: unit || 'pcs', currentQuantity: 0,
			partDefinitionId, partNumber, recentTransactions: [], updatedAt: new Date()
		});
		return { success: true };
	},

	recordTransaction: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const data = await request.formData();
		const materialId = data.get('materialId') as string;
		const transactionType = data.get('transactionType') as string;
		const quantity = Number(data.get('quantity'));
		const notes = data.get('notes') as string;
		const material = await ManufacturingMaterial.findById(materialId).lean() as any;
		if (!material) return fail(404, { error: 'Material not found' });
		const quantityBefore = material.currentQuantity ?? 0;
		const quantityChanged = transactionType === 'consume' ? -Math.abs(quantity) : Math.abs(quantity);
		const quantityAfter = quantityBefore + quantityChanged;
		const now = new Date();
		await ManufacturingMaterialTransaction.create({
			_id: generateId(), materialId, transactionType, quantityChanged,
			quantityBefore, quantityAfter, operatorId: locals.user._id,
			notes: notes || undefined, createdAt: now
		});
		await ManufacturingMaterial.findByIdAndUpdate(materialId, {
			$set: { currentQuantity: quantityAfter, updatedAt: now },
			$push: { recentTransactions: { $each: [{ transactionType, quantityChanged, quantityBefore, quantityAfter, operatorId: locals.user._id, notes: notes || undefined, createdAt: now }], $slice: -100 } }
		});
		if (material.partDefinitionId) {
			await PartDefinition.findByIdAndUpdate(material.partDefinitionId, { $inc: { inventoryCount: quantityChanged } });
		}
		return { success: true };
	}
};
