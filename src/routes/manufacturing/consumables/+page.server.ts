import { redirect, fail } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import {
	connectDB, CartridgeRecord, WaxFillingRun, ReagentBatchRecord,
	ManufacturingMaterial, ManufacturingMaterialTransaction,
	ManufacturingSettings, PartDefinition, User, AuditLog, generateId
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
		{ $group: { _id: null, totalRuns: { $sum: 1 } } }
	]);
	const reagentStats = await ReagentBatchRecord.aggregate([
		{ $match: { status: { $in: ['completed', 'Completed'] } } },
		{ $group: { _id: null, totalRuns: { $sum: 1 } } }
	]);

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

	// === Parts inventory (cartridge BOM) ===
	const parts = await PartDefinition.find({ bomType: 'cartridge', isActive: true })
		.sort({ sortOrder: 1, name: 1 }).lean();

	const partsList = (parts as any[]).map((p: any) => ({
		id: String(p._id),
		partNumber: p.partNumber ?? '',
		name: p.name ?? '',
		category: p.category ?? '',
		inventoryCount: p.inventoryCount ?? 0,
		unitOfMeasure: p.unitOfMeasure ?? 'pcs',
		supplier: p.supplier ?? ''
	}));

	// === Settings ===
	const settingsDoc = await ManufacturingSettings.findById('default').lean();
	const general = (settingsDoc as any)?.general ?? {};
	const cartridgesPerSheet = general.cartridgesPerLaserCutSheet ?? 13;

	const laserCutPart = partsList.find((p) => /laser.?cut|substrate|thermoseal.?sheet/i.test(p.name));
	const individualBacks = (laserCutPart?.inventoryCount ?? 0) * cartridgesPerSheet;

	// === Recent manual edits ===
	const recentEdits = await AuditLog.find({ action: 'manual_inventory_edit' })
		.sort({ timestamp: -1 }).limit(20).lean();
	const editsList = (recentEdits as any[]).map((e: any) => ({
		id: String(e._id),
		username: e.username ?? '',
		partName: e.details?.partName ?? '',
		partNumber: e.details?.partNumber ?? '',
		type: e.details?.transactionType ?? '',
		quantity: e.details?.quantity ?? 0,
		reason: e.details?.reason ?? '',
		timestamp: e.timestamp ? new Date(e.timestamp).toISOString() : ''
	}));

	// Pipeline stages
	const stages = [
		{
			id: 'cut-thermoseal', name: 'Cut Thermoseal', href: '/manufacturing/wi-02',
			inputs: [{ name: 'Thermoseal Roll', icon: '🧻', count: null as number | null, unit: 'rolls (ROG)' }],
			outputs: [{ name: 'Thermoseal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'cut-topseal', name: 'Cut Top Seal', href: '/manufacturing/wi-03',
			inputs: [{ name: 'Top Seal Roll', icon: '🧻', count: null as number | null, unit: 'rolls (ROG)' }],
			outputs: [{ name: 'Top Seal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'laser', name: 'Laser Cut', href: '/manufacturing/laser-cutting',
			inputs: [{ name: 'Thermoseal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }],
			outputs: [{ name: 'Cartridge Backs', icon: '🔲', count: individualBacks > 0 ? individualBacks : null, unit: `backs (${cartridgesPerSheet}/sheet)` }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'backing', name: 'Cartridge Back', href: '/manufacturing/wi-01',
			inputs: [
				{ name: 'Cartridge Back (laser cut)', icon: '🔲', count: individualBacks > 0 ? individualBacks : null, unit: 'backs' },
				{ name: 'Raw Cartridge', icon: '📦', count: null as number | null, unit: 'cartridges (ROG)' },
				{ name: 'Barcode Label', icon: '🏷️', count: null as number | null, unit: 'labels' }
			],
			outputs: [{ name: 'Backed Cartridges', icon: '📦', count: backedCount, unit: 'cartridges' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'wax', name: 'Wax Filling', href: '/manufacturing/wax-filling',
			inputs: [
				{ name: 'Backed Cartridges', icon: '📦', count: backedCount, unit: 'cartridges' },
				{ name: 'Wax (source lots)', icon: '🕯️', count: null as number | null, unit: 'tubes' },
				{ name: 'Pipette Tips', icon: '🔬', count: null as number | null, unit: 'tips' }
			],
			outputs: [
				{ name: 'Wax-Filled', icon: '🟡', count: (phaseMap.get('wax_stored') ?? 0) + (phaseMap.get('wax_filled') ?? 0), unit: 'cartridges' },
				{ name: 'In Fridge', icon: '❄️', count: waxStored, unit: 'stored' }
			],
			activeRuns: activeWaxRuns, completedRuns: waxStats[0]?.totalRuns ?? 0
		},
		{
			id: 'reagent', name: 'Reagent Filling', href: '/manufacturing/reagent-filling',
			inputs: [
				{ name: 'Wax-Filled Cartridges', icon: '🟡', count: waxStored, unit: 'available' },
				{ name: 'Reagents (per assay)', icon: '💧', count: null as number | null, unit: 'wells' },
				{ name: 'Pipette Tips', icon: '🔬', count: null as number | null, unit: 'tips' }
			],
			outputs: [
				{ name: 'Reagent-Filled', icon: '🟣', count: reagentStored + sealed, unit: 'cartridges' },
				{ name: 'In Fridge', icon: '❄️', count: reagentStored, unit: 'stored' }
			],
			activeRuns: activeReagentRuns, completedRuns: reagentStats[0]?.totalRuns ?? 0
		},
		{
			id: 'topseal-apply', name: 'Top Seal Apply', href: '/manufacturing/top-seal-cutting',
			inputs: [
				{ name: 'Reagent-Filled Cartridges', icon: '🟣', count: reagentStored, unit: 'available' },
				{ name: 'Top Seal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }
			],
			outputs: [{ name: 'Sealed Cartridges', icon: '✅', count: sealed, unit: 'cartridges' }],
			activeRuns: 0, completedRuns: 0
		},
		{
			id: 'qaqc', name: 'QA/QC', href: '/manufacturing/qa-qc',
			inputs: [{ name: 'Sealed Cartridges', icon: '✅', count: sealed, unit: 'cartridges' }],
			outputs: [
				{ name: 'Released', icon: '🎯', count: null as number | null, unit: 'cartridges' },
				{ name: 'Voided', icon: '🚫', count: voided, unit: 'cartridges' }
			],
			activeRuns: 0, completedRuns: 0
		}
	];

	// Link part inventory counts to pipeline
	for (const part of partsList) {
		const pname = part.name.toLowerCase();
		for (const stage of stages) {
			for (const item of [...stage.inputs, ...stage.outputs]) {
				if (item.count === null) {
					const iname = item.name.toLowerCase().replace(/\(.*\)/, '').trim();
					if (pname.includes(iname.slice(0, 10)) || iname.includes(pname.slice(0, 10))) {
						item.count = part.inventoryCount;
					}
				}
			}
		}
	}

	return {
		stages,
		parts: JSON.parse(JSON.stringify(partsList)),
		recentEdits: JSON.parse(JSON.stringify(editsList)),
		derived: { individualBacks, cartridgesPerSheet },
		totals: { backed: backedCount, waxStored, reagentStored, sealed, voided, totalInSystem: backedCount }
	};
};

export const actions: Actions = {
	/** Manual inventory edit — requires admin password + reason */
	manualEdit: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const partId = data.get('partId') as string;
		const transactionType = data.get('transactionType') as string;
		const quantity = Number(data.get('quantity'));
		const reason = (data.get('reason') as string)?.trim();
		const adminUsername = (data.get('adminUsername') as string)?.trim();
		const adminPassword = data.get('adminPassword') as string;

		if (!partId) return fail(400, { error: 'Select a part' });
		if (!quantity || quantity <= 0) return fail(400, { error: 'Quantity must be positive' });
		if (!reason) return fail(400, { error: 'Reason is required for manual edits' });
		if (!adminUsername || !adminPassword) return fail(400, { error: 'Admin credentials required' });

		// Verify admin credentials
		const adminUser = await User.findOne({ username: adminUsername }).lean() as any;
		if (!adminUser) return fail(403, { error: 'Invalid admin credentials' });
		const validPassword = await bcrypt.compare(adminPassword, adminUser.passwordHash);
		if (!validPassword) return fail(403, { error: 'Invalid admin credentials' });

		// Check admin role
		if (adminUser.role !== 'admin' && adminUser.role !== 'manager') {
			return fail(403, { error: 'Only admin or manager accounts can authorize manual edits' });
		}

		const part = await PartDefinition.findById(partId).lean() as any;
		if (!part) return fail(404, { error: 'Part not found' });

		const quantityChanged = transactionType === 'consume' ? -Math.abs(quantity) : Math.abs(quantity);
		const newCount = (part.inventoryCount ?? 0) + quantityChanged;

		await PartDefinition.findByIdAndUpdate(partId, {
			$set: { inventoryCount: Math.max(0, newCount) }
		});

		// Audit log
		await AuditLog.create({
			_id: generateId(),
			action: 'manual_inventory_edit',
			resourceType: 'part_definition',
			resourceId: partId,
			userId: locals.user._id,
			username: locals.user.username,
			timestamp: new Date(),
			details: {
				partName: part.name,
				partNumber: part.partNumber,
				transactionType,
				quantity: Math.abs(quantity),
				quantityChanged,
				previousCount: part.inventoryCount ?? 0,
				newCount: Math.max(0, newCount),
				reason,
				authorizedBy: adminUsername
			}
		});

		// Sync linked ManufacturingMaterial if exists
		const linkedMat = await ManufacturingMaterial.findOne({ partDefinitionId: partId }).lean() as any;
		if (linkedMat) {
			const matBefore = linkedMat.currentQuantity ?? 0;
			const matAfter = matBefore + quantityChanged;
			await ManufacturingMaterialTransaction.create({
				_id: generateId(), materialId: linkedMat._id, transactionType, quantityChanged,
				quantityBefore: matBefore, quantityAfter: Math.max(0, matAfter),
				operatorId: locals.user._id, notes: `Manual edit: ${reason} (authorized by ${adminUsername})`,
				createdAt: new Date()
			});
			await ManufacturingMaterial.findByIdAndUpdate(linkedMat._id, {
				$set: { currentQuantity: Math.max(0, matAfter), updatedAt: new Date() }
			});
		}

		return { success: true };
	}
};

export const config = { maxDuration: 60 };
