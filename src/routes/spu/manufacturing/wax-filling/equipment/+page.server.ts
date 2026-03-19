import { redirect, fail } from '@sveltejs/kit';
import {
	connectDB, Consumable, Equipment, ManufacturingSettings, WaxFillingRun, generateId
} from '$lib/server/db';
import { isAdmin as checkAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const config = { maxDuration: 60 };

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');

	try {
	await connectDB();

	const [decksRaw, traysRaw, equipmentRaw, settingsDoc, activeWaxRunsRaw] = await Promise.all([
		Consumable.find({ type: 'deck' }).sort({ createdAt: -1 }).lean(),
		Consumable.find({ type: 'cooling_tray' }).sort({ createdAt: -1 }).lean(),
		Equipment.find({}).sort({ name: 1 }).lean(),
		ManufacturingSettings.findById('default').lean(),
		WaxFillingRun.find({
			status: { $nin: ['completed', 'aborted', 'cancelled'] }
		}).lean()
	]);

	// Fetch active reagent runs
	let activeReagentRunsRaw: any[] = [];
	let reagentRunHistoryRaw: any[] = [];
	try {
		const mongoose = (await import('mongoose')).default;
		const db = mongoose.connection.db;
		if (db) {
			const cols = await db.listCollections({ name: 'reagent_filling_runs' }).toArray();
			if (cols.length) {
				[activeReagentRunsRaw, reagentRunHistoryRaw] = await Promise.all([
					db.collection('reagent_filling_runs').find({
						status: { $nin: ['completed', 'aborted', 'cancelled'] }
					}).toArray(),
					db.collection('reagent_filling_runs').find(
						{ status: { $in: ['completed', 'aborted', 'cancelled'] } },
						{ sort: { createdAt: -1 }, limit: 50 }
					).toArray()
				]);
			}
		}
	} catch { /* ignore */ }

	// Fetch wax run history
	const waxRunHistoryRaw = await WaxFillingRun.find({
		status: { $in: ['completed', 'aborted', 'cancelled'] }
	}).sort({ createdAt: -1 }).limit(50).lean();

	const rejectionCodes = ((settingsDoc as any)?.rejectionReasonCodes ?? [])
		.map((r: any, i: number) => ({
			id: r._id ?? String(i),
			code: r.code ?? '',
			label: r.label ?? '',
			sortOrder: r.sortOrder ?? i
		}));

	// Serialize decks
	const decks = (decksRaw as any[]).map((d) => ({
		deckId: String(d._id),
		status: d.status ?? 'Available',
		currentRobotId: d.currentRobotId ?? null,
		lockoutUntil: d.lockoutUntil ? new Date(d.lockoutUntil).toISOString() : null,
		lastUsed: d.lastUsed ? new Date(d.lastUsed).toISOString() : null,
		createdAt: d.createdAt ? new Date(d.createdAt).toISOString() : '',
		updatedAt: d.updatedAt ? new Date(d.updatedAt).toISOString() : ''
	}));

	// Serialize cooling trays
	const trays = (traysRaw as any[]).map((t) => ({
		trayId: String(t._id),
		status: t.status ?? 'Available',
		assignedRunId: t.assignedRunId ?? null,
		createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : '',
		updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : ''
	}));

	// Serialize equipment list (ovens, fridges, incubators)
	const equipmentList = (equipmentRaw as any[]).map((e) => ({
		equipmentId: String(e._id),
		name: e.name ?? '',
		equipmentType: e.equipmentType ?? e.type ?? 'unknown',
		status: e.status ?? 'active',
		currentTemperatureC: e.currentTemperatureC ?? null
	}));

	// Placements (equipment location assignments) — not stored separately, build from equipment
	const placements: { locationId: string; locationType: string; displayName: string; itemType: string; itemId: string }[] = [];

	// Serialize active wax runs
	const activeWaxRuns = (activeWaxRunsRaw as any[]).map((r) => ({
		runId: String(r._id),
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		coolingTrayId: r.coolingTrayId ?? null,
		status: r.status ?? ''
	}));

	// Serialize active reagent runs
	const activeReagentRuns = activeReagentRunsRaw.map((r: any) => ({
		runId: String(r._id),
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		status: r.status ?? ''
	}));

	// Wax run history
	const waxRunHistory = (waxRunHistoryRaw as any[]).map((r) => ({
		runId: String(r._id),
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		coolingTrayId: r.coolingTrayId ?? null,
		waxSourceLot: r.waxSourceLot ?? null,
		status: r.status ?? '',
		operatorName: (r.operator?.username ?? r.operator?._id) ?? 'Unknown',
		abortReason: r.abortReason ?? null,
		plannedCartridgeCount: r.plannedCartridgeCount ?? r.cartridgeIds?.length ?? null,
		runStartTime: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
		runEndTime: r.runEndTime ? new Date(r.runEndTime).toISOString() : null,
		createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : ''
	}));

	// Reagent run history
	const reagentRunHistory = reagentRunHistoryRaw.map((r: any) => ({
		runId: String(r._id),
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		status: r.status ?? '',
		operatorName: (r.operator?.username ?? r.operator?._id) ?? 'Unknown',
		abortReason: r.abortReason ?? null,
		cartridgeCount: r.cartridgeCount ?? r.cartridgesFilled?.length ?? null,
		runStartTime: r.runStartTime ? new Date(r.runStartTime).toISOString() : null,
		runEndTime: r.runEndTime ? new Date(r.runEndTime).toISOString() : null,
		createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : ''
	}));

	return {
		decks,
		trays,
		rejectionCodes,
		isAdmin: checkAdmin(locals.user),
		equipmentList,
		placements,
		activeWaxRuns,
		activeReagentRuns,
		waxRunHistory,
		reagentRunHistory
	};
	} catch (err) {
		console.error('[WAX-FILLING EQUIPMENT] Load error:', err instanceof Error ? err.message : err);
		return {
			decks: [], trays: [], rejectionCodes: [], isAdmin: checkAdmin(locals.user),
			equipmentList: [], placements: [], activeWaxRuns: [], activeReagentRuns: [],
			waxRunHistory: [], reagentRunHistory: []
		};
	}
};

export const actions: Actions = {
	/** Update deck status */
	updateDeckStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const deckId = data.get('deckId') as string;
		const status = data.get('status') as string;

		if (!deckId) return fail(400, { error: 'Deck ID required' });

		await Consumable.findOneAndUpdate(
			{ _id: deckId, type: 'deck' },
			{ $set: { status, lastUsed: new Date() } }
		);

		return { success: true, message: `Deck ${deckId} status updated to ${status}` };
	},

	/** Update cooling tray status */
	updateTrayStatus: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const trayId = data.get('trayId') as string;
		const status = data.get('status') as string;

		if (!trayId) return fail(400, { error: 'Tray ID required' });

		await Consumable.findOneAndUpdate(
			{ _id: trayId, type: 'cooling_tray' },
			{ $set: { status } }
		);

		return { success: true, message: `Tray ${trayId} status updated to ${status}` };
	},

	/** Add a rejection code */
	addRejectionCode: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!checkAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const code = data.get('code') as string;
		const label = data.get('label') as string;
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		if (!code || !label) return fail(400, { error: 'Code and label are required' });

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{
				$push: {
					rejectionReasonCodes: {
						_id: generateId(), code, label, processType: 'wax', sortOrder
					}
				}
			},
			{ upsert: true }
		);

		return { success: true, message: 'Rejection code added' };
	},

	/** Edit a rejection code */
	editRejectionCode: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!checkAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const id = data.get('id') as string;
		const label = data.get('label') as string;
		const sortOrder = Number(data.get('sortOrder') ?? 0);

		await ManufacturingSettings.findOneAndUpdate(
			{ 'rejectionReasonCodes._id': id },
			{
				$set: {
					'rejectionReasonCodes.$.label': label,
					'rejectionReasonCodes.$.sortOrder': sortOrder
				}
			}
		);

		return { success: true, message: 'Rejection code updated' };
	},

	/** Remove a rejection code */
	removeRejectionCode: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		if (!checkAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const id = data.get('id') as string;

		await ManufacturingSettings.findByIdAndUpdate(
			'default',
			{ $pull: { rejectionReasonCodes: { _id: id } } }
		);

		return { success: true, message: 'Rejection code removed' };
	}
};
