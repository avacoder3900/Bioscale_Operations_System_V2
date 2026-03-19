import { redirect } from '@sveltejs/kit';
import { connectDB, CartridgeRecord, WaxFillingRun, ReagentBatchRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	// Count cartridges by phase across the entire pipeline
	const phaseCounts = await CartridgeRecord.aggregate([
		{ $group: { _id: '$currentPhase', count: { $sum: 1 } } }
	]);
	const phaseMap = new Map<string, number>(phaseCounts.map((p: any) => [p._id ?? 'unknown', p.count]));

	// Count cartridges with backing recorded (includes all downstream phases)
	const backedCount = await CartridgeRecord.countDocuments({ 'backing.recordedAt': { $exists: true } });

	// Wax filling stats
	const waxStats = await WaxFillingRun.aggregate([
		{ $match: { status: { $in: ['completed', 'Completed'] } } },
		{ $group: { _id: null, totalRuns: { $sum: 1 }, totalCartridges: { $sum: '$cartridgeCount' } } }
	]);
	const waxCompleted = waxStats[0] ?? { totalRuns: 0, totalCartridges: 0 };

	// Reagent filling stats
	const reagentStats = await ReagentBatchRecord.aggregate([
		{ $match: { status: { $in: ['completed', 'Completed'] } } },
		{ $group: { _id: null, totalRuns: { $sum: 1 }, totalCartridges: { $sum: '$cartridgeCount' } } }
	]);
	const reagentCompleted = reagentStats[0] ?? { totalRuns: 0, totalCartridges: 0 };

	// Active runs
	const activeWaxRuns = await WaxFillingRun.countDocuments({
		status: { $nin: ['completed', 'Completed', 'aborted', 'cancelled', 'voided'] }
	});
	const activeReagentRuns = await ReagentBatchRecord.countDocuments({
		status: { $nin: ['completed', 'Completed', 'aborted', 'Aborted', 'cancelled', 'Cancelled', 'voided'] }
	});

	// Cartridges in storage (wax + reagent)
	const waxStored = await CartridgeRecord.countDocuments({ currentPhase: 'wax_stored' });
	const reagentStored = await CartridgeRecord.countDocuments({ currentPhase: 'stored' });
	const sealed = await CartridgeRecord.countDocuments({ currentPhase: 'sealed' });
	const voided = await CartridgeRecord.countDocuments({ currentPhase: 'voided' });

	// Build pipeline stages with inputs consumed and outputs produced
	const stages = [
		{
			id: 'cut-thermoseal',
			name: 'Cut Thermoseal',
			href: '/spu/manufacturing/wi-02',
			inputs: [
				{ name: 'Thermoseal Roll', icon: '🧻', count: null as number | null, unit: 'rolls (ROG)' }
			],
			outputs: [
				{ name: 'Thermoseal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }
			],
			activeRuns: 0,
			completedRuns: 0
		},
		{
			id: 'cut-topseal',
			name: 'Cut Top Seal',
			href: '/spu/manufacturing/wi-03',
			inputs: [
				{ name: 'Top Seal Roll', icon: '🧻', count: null as number | null, unit: 'rolls (ROG)' }
			],
			outputs: [
				{ name: 'Top Seal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }
			],
			activeRuns: 0,
			completedRuns: 0
		},
		{
			id: 'laser',
			name: 'Laser Cut',
			href: '/spu/manufacturing/laser-cutting',
			inputs: [
				{ name: 'Thermoseal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }
			],
			outputs: [
				{ name: 'Cartridge Backs', icon: '🔲', count: null as number | null, unit: 'backs (13 per sheet)' }
			],
			activeRuns: 0,
			completedRuns: 0
		},
		{
			id: 'backing',
			name: 'Cartridge Back',
			href: '/spu/manufacturing/wi-01',
			inputs: [
				{ name: 'Cartridge Back (laser cut)', icon: '🔲', count: null as number | null, unit: 'backs' },
				{ name: 'Raw Cartridge', icon: '📦', count: null as number | null, unit: 'cartridges (ROG)' },
				{ name: 'Barcode Label', icon: '🏷️', count: null as number | null, unit: 'labels' }
			],
			outputs: [
				{ name: 'Backed Cartridges', icon: '📦', count: backedCount, unit: 'cartridges' }
			],
			activeRuns: 0,
			completedRuns: 0
		},
		{
			id: 'wax',
			name: 'Wax Filling',
			href: '/spu/manufacturing/wax-filling',
			inputs: [
				{ name: 'Backed Cartridges', icon: '📦', count: backedCount, unit: 'cartridges' },
				{ name: 'Wax (source lots)', icon: '🕯️', count: null as number | null, unit: 'tubes' },
				{ name: 'Pipette Tips', icon: '🔬', count: null as number | null, unit: 'tips' }
			],
			outputs: [
				{ name: 'Wax-Filled Cartridges', icon: '🟡', count: (phaseMap.get('wax_stored') ?? 0) + (phaseMap.get('wax_filled') ?? 0), unit: 'cartridges' },
				{ name: 'In Fridge Storage', icon: '❄️', count: waxStored, unit: 'stored' }
			],
			activeRuns: activeWaxRuns,
			completedRuns: waxCompleted.totalRuns ?? 0
		},
		{
			id: 'reagent',
			name: 'Reagent Filling',
			href: '/spu/manufacturing/reagent-filling',
			inputs: [
				{ name: 'Wax-Filled Cartridges', icon: '🟡', count: waxStored, unit: 'available' },
				{ name: 'Reagents (per assay)', icon: '💧', count: null as number | null, unit: 'wells' },
				{ name: 'Pipette Tips', icon: '🔬', count: null as number | null, unit: 'tips' }
			],
			outputs: [
				{ name: 'Reagent-Filled Cartridges', icon: '🟣', count: reagentStored + sealed, unit: 'cartridges' },
				{ name: 'In Fridge Storage', icon: '❄️', count: reagentStored, unit: 'stored' }
			],
			activeRuns: activeReagentRuns,
			completedRuns: reagentCompleted.totalRuns ?? 0
		},
		{
			id: 'topseal-apply',
			name: 'Top Seal Apply',
			href: '/spu/manufacturing/top-seal-cutting',
			inputs: [
				{ name: 'Reagent-Filled Cartridges', icon: '🟣', count: reagentStored, unit: 'available' },
				{ name: 'Top Seal Sheets', icon: '📄', count: null as number | null, unit: 'sheets' }
			],
			outputs: [
				{ name: 'Sealed Cartridges', icon: '✅', count: sealed, unit: 'cartridges' }
			],
			activeRuns: 0,
			completedRuns: 0
		},
		{
			id: 'qaqc',
			name: 'QA/QC',
			href: '/spu/manufacturing/qa-qc',
			inputs: [
				{ name: 'Sealed Cartridges', icon: '✅', count: sealed, unit: 'cartridges' }
			],
			outputs: [
				{ name: 'Released Cartridges', icon: '🎯', count: null as number | null, unit: 'cartridges' },
				{ name: 'Voided / Rejected', icon: '🚫', count: voided, unit: 'cartridges' }
			],
			activeRuns: 0,
			completedRuns: 0
		}
	];

	return {
		stages,
		totals: {
			backed: backedCount,
			waxFilled: (phaseMap.get('wax_stored') ?? 0) + (phaseMap.get('wax_filled') ?? 0),
			waxStored,
			reagentFilled: reagentStored + sealed,
			reagentStored,
			sealed,
			voided,
			totalInSystem: backedCount
		}
	};
};
