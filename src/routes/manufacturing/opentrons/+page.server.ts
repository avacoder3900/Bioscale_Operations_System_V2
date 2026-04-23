import { fail, redirect } from '@sveltejs/kit';
import {
	connectDB, Equipment, WaxFillingRun, ReagentBatchRecord,
	CartridgeRecord, ManualCartridgeRemoval, AuditLog, generateId
} from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { recordTransaction } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';

// Extend Vercel serverless timeout to 60s
export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	// Fetch all active robots
	const robots = await Equipment.find({ equipmentType: 'robot', isActive: true }, {
		_id: 1, name: 1, robotSide: 1
	}).lean();

	const robotList = robots.map((r: any) => ({
		robotId: r._id,
		name: r.name ?? '',
		description: r.robotSide ?? ''
	}));

	// Filling-page-owned stages — while a run is in these, the operator is
	// actively handling it on the filling page and the robot is unavailable.
	// Runs past these (QC/Storage wax; Top Sealing/Storage reagent) live on
	// Opentron Control and don't block new filling runs.
	const WAX_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Awaiting Removal',
		'setup', 'loading', 'running', 'awaiting_removal', 'cooling'];
	const REAGENT_PAGE_OWNED = ['Setup', 'Loading', 'Running', 'Inspection',
		'setup', 'loading', 'running', 'inspection'];

	const activeWaxRuns = await WaxFillingRun.find({
		status: { $in: WAX_PAGE_OWNED }
	}).lean();

	// Build wax state per robot
	const waxState = robotList.map((robot) => {
		const run = activeWaxRuns.find((r: any) => r.robot?._id === robot.robotId);
		return {
			robotId: robot.robotId,
			name: robot.name,
			hasActiveRun: !!run,
			stage: run ? (run as any).status ?? null : null,
			alerts: [] as { type: string; message: string }[]
		};
	});

	// Build reagent state per robot using ReagentBatchRecord model
	const activeReagentRuns = await ReagentBatchRecord.find({
		status: { $in: REAGENT_PAGE_OWNED }
	}).lean().catch(() => []);

	const reagentState = robotList.map((robot) => {
		const run = (activeReagentRuns as any[]).find((r: any) => r.robot?._id === robot.robotId);
		return {
			robotId: robot.robotId,
			name: robot.name,
			hasActiveRun: !!run,
			stage: run ? run.status ?? null : null,
			assayTypeName: run ? run.assayTypeName ?? null : null
		};
	});

	// Robot availability: a robot is unavailable if it has an active wax OR reagent run
	const robotAvailability = robotList.map((robot) => {
		const wax = waxState.find((w) => w.robotId === robot.robotId);
		const reagent = reagentState.find((r) => r.robotId === robot.robotId);
		const waxActive = wax?.hasActiveRun ?? false;
		const reagentActive = reagent?.hasActiveRun ?? false;
		const activeWax = activeWaxRuns.find((r: any) => r.robot?._id === robot.robotId);
		const activeReagent = (activeReagentRuns as any[]).find((r: any) => r.robot?._id === robot.robotId);

		return {
			robotId: robot.robotId,
			available: !waxActive && !reagentActive,
			activeProcess: waxActive ? 'wax' : reagentActive ? 'reagent' : null,
			activeRunId: activeWax?._id ?? activeReagent?._id ?? null
		};
	});

	// Robot stats: count completed/aborted wax and reagent runs per robot
	const allWaxRuns = await WaxFillingRun.find({}, { 'robot._id': 1, status: 1 }).lean();
	const allReagentRuns = await ReagentBatchRecord.find({}, { 'robot._id': 1, status: 1 }).lean().catch(() => []);

	const robotStats = robotList.map((robot) => {
		const waxRuns = allWaxRuns.filter((r: any) => r.robot?._id === robot.robotId);
		const reagentRuns = (allReagentRuns as any[]).filter((r: any) => r.robot?._id === robot.robotId);

		return {
			robotId: robot.robotId,
			waxRuns: {
				total: waxRuns.length,
				completed: waxRuns.filter((r: any) => r.status === 'completed').length,
				aborted: waxRuns.filter((r: any) => r.status === 'aborted').length
			},
			reagentRuns: {
				total: reagentRuns.length,
				completed: reagentRuns.filter((r: any) => r.status === 'completed').length,
				aborted: reagentRuns.filter((r: any) => r.status === 'aborted').length
			}
		};
	});

	// Manual cartridge removal history — last 50 groups
	const removals = await ManualCartridgeRemoval.find({})
		.sort({ removedAt: -1 })
		.limit(50)
		.lean() as any[];

	const removalHistory = removals.map((r) => ({
		id: String(r._id),
		cartridgeIds: r.cartridgeIds ?? [],
		cartridgeCount: (r.cartridgeIds ?? []).length,
		reason: r.reason ?? '',
		operatorUsername: r.operator?.username ?? '',
		removedAt: r.removedAt ? new Date(r.removedAt).toISOString() : ''
	}));

	return {
		robots: robotList,
		waxState,
		reagentState,
		robotAvailability,
		robotStats,
		removalHistory
	};
};

export const actions: Actions = {
	/**
	 * Manually remove a group of wax-stored cartridges. Operators scan 1+
	 * cartridges, provide a reason, and submit. Each cartridge is marked
	 * scrapped and a scrap InventoryTransaction is written so the scrap audit
	 * (see scripts/audit-scrap-tracking.ts) remains clean.
	 */
	removeWaxStoredCartridges: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const cartridgeIdsRaw = (data.get('cartridgeIds') as string) ?? '';
		const reason = ((data.get('reason') as string) ?? '').trim();

		let cartridgeIds: string[] = [];
		try { cartridgeIds = JSON.parse(cartridgeIdsRaw); } catch { /* ignore */ }
		cartridgeIds = Array.from(new Set(cartridgeIds.map((s) => String(s).trim()).filter(Boolean)));

		if (cartridgeIds.length === 0) {
			return fail(400, { removeWaxStored: { error: 'Scan at least one cartridge barcode' } });
		}
		if (!reason) {
			return fail(400, { removeWaxStored: { error: 'Reason is required' } });
		}

		// Validate eligibility: each cartridge must exist and be status='wax_stored'.
		// Fail the whole group on any mismatch so operators get a clear failure
		// mode rather than a silent partial-success.
		const cartridges = await CartridgeRecord.find({ _id: { $in: cartridgeIds } })
			.select('_id status')
			.lean() as any[];
		const byId = new Map(cartridges.map((c) => [c._id, c]));
		const issues: string[] = [];
		for (const cid of cartridgeIds) {
			const c = byId.get(cid);
			if (!c) { issues.push(`${cid}: not found`); continue; }
			if (c.status !== 'wax_stored') { issues.push(`${cid}: status is '${c.status}', expected 'wax_stored'`); }
		}
		if (issues.length > 0) {
			return fail(400, { removeWaxStored: { error: `Cannot remove: ${issues.join('; ')}` } });
		}

		const now = new Date();
		const removalId = generateId();
		const voidReason = `Manual wax-stored removal: ${reason}`;

		await ManualCartridgeRemoval.create({
			_id: removalId,
			cartridgeIds,
			reason,
			operator: { _id: locals.user._id, username: locals.user.username },
			removedAt: now
		});

		// Mark each cartridge scrapped and emit scrap InventoryTransaction.
		for (const cid of cartridgeIds) {
			await CartridgeRecord.findByIdAndUpdate(cid, {
				$set: { status: 'scrapped', voidedAt: now, voidReason }
			});

			await recordTransaction({
				transactionType: 'scrap',
				cartridgeRecordId: cid,
				quantity: 1,
				manufacturingStep: 'storage',
				manufacturingRunId: removalId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				scrapReason: reason,
				scrapCategory: 'other',
				notes: `Manual wax-stored removal (group ${removalId}): ${reason}`
			});

			await AuditLog.create({
				_id: generateId(),
				tableName: 'cartridge_records',
				recordId: cid,
				action: 'UPDATE',
				changedBy: locals.user.username,
				changedAt: now,
				newData: { status: 'scrapped', voidedAt: now, voidReason, removalGroupId: removalId },
				reason: voidReason
			});
		}

		return {
			removeWaxStored: {
				success: true,
				removalId,
				count: cartridgeIds.length
			}
		};
	}
};
