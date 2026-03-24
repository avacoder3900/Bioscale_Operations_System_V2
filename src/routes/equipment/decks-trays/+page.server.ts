export const config = { maxDuration: 60 };
import { fail } from '@sveltejs/kit';
import bcrypt from 'bcryptjs';
import { connectDB, generateId, Equipment, AuditLog, User } from '$lib/server/db';
import { WaxFillingRun } from '$lib/server/db/models/wax-filling-run.js';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	try {
		await connectDB();

		const [decks, trays] = await Promise.all([
			Equipment.find({ equipmentType: 'deck' }).sort({ _id: 1 }).lean(),
			Equipment.find({ equipmentType: 'cooling_tray' }).sort({ _id: 1 }).lean()
		]);

		// Fetch recent wax filling runs for decks
		const deckIds = (decks as any[]).map((d: any) => d._id);
		const trayIds = (trays as any[]).map((t: any) => t._id);

		const [deckRuns, trayRuns] = await Promise.all([
			deckIds.length
				? WaxFillingRun.find({ deckId: { $in: deckIds } })
					.sort({ runStartTime: -1 })
					.limit(500)
					.lean()
				: Promise.resolve([]),
			trayIds.length
				? WaxFillingRun.find({ coolingTrayId: { $in: trayIds } })
					.sort({ runStartTime: -1 })
					.limit(500)
					.lean()
				: Promise.resolve([])
		]);

		// Group runs by deck/tray
		const runsByDeck = new Map<string, any[]>();
		for (const r of deckRuns as any[]) {
			const did = (r as any).deckId;
			if (did) {
				if (!runsByDeck.has(did)) runsByDeck.set(did, []);
				runsByDeck.get(did)!.push(r);
			}
		}
		const runsByTray = new Map<string, any[]>();
		for (const r of trayRuns as any[]) {
			const tid = (r as any).coolingTrayId;
			if (tid) {
				if (!runsByTray.has(tid)) runsByTray.set(tid, []);
				runsByTray.get(tid)!.push(r);
			}
		}

		return {
			decks: (decks as any[]).map((d: any) => {
				const runs = (runsByDeck.get(d._id) ?? []).slice(0, 10);
				return {
					deckId: d._id,
					status: mapConsumableStatus(d.status),
					currentRobotId: d.currentRobotId ?? null,
					lastUsed: d.lastUsed ?? null,
					lockoutUntil: d.lockoutUntil ?? null,
					totalRuns: (d.usageLog ?? []).length,
					createdAt: d.createdAt?.toISOString?.() ?? d.createdAt ?? null,
					recentRuns: runs.map(mapDeckRun)
				};
			}),
			trays: (trays as any[]).map((t: any) => {
				const runs = (runsByTray.get(t._id) ?? []).slice(0, 10);
				return {
					trayId: t._id,
					status: mapConsumableStatus(t.status),
					assignedRunId: t.assignedRunId ?? null,
					totalRuns: (t.usageLog ?? []).length,
					createdAt: t.createdAt?.toISOString?.() ?? t.createdAt ?? null,
					recentRuns: runs.map(mapTrayRun)
				};
			}),
			isAdmin: isAdmin(locals.user)
		};
	} catch (err) {
		console.error('[EQUIPMENT decks-trays] Load error:', err instanceof Error ? err.message : err);
		return { decks: [], trays: [], isAdmin: isAdmin(locals.user) };
	}
};

function mapConsumableStatus(status: string | undefined): string {
	switch (status) {
		case 'available': return 'Available';
		case 'in_use': return 'In Use';
		case 'cooldown_lockout': return 'Cooldown Lockout';
		case 'needs_cleaning': return 'Needs Cleaning';
		case 'out_of_service': return 'Out of Service';
		case 'in_qc': return 'In QC';
		default: return status ?? 'Available';
	}
}

function statusToDb(status: string): string {
	switch (status) {
		case 'Available': return 'available';
		case 'In Use': return 'in_use';
		case 'Cooldown Lockout': return 'cooldown_lockout';
		case 'Needs Cleaning': return 'needs_cleaning';
		case 'Out of Service': return 'out_of_service';
		case 'In QC': return 'in_qc';
		default: return 'available';
	}
}

function mapDeckRun(r: any) {
	return {
		runId: r._id,
		robotId: r.robot?._id ?? '',
		status: r.status ?? '',
		operatorName: r.operator?.username ?? '',
		waxSourceLot: r.waxSourceLot ?? null,
		cartridgeCount: r.plannedCartridgeCount ?? 0,
		coolingTrayId: r.coolingTrayId ?? null,
		durationMinutes: r.runStartTime && r.runEndTime
			? Math.round((new Date(r.runEndTime).getTime() - new Date(r.runStartTime).getTime()) / 60000)
			: null,
		date: r.runStartTime ?? r.createdAt ?? ''
	};
}

function mapTrayRun(r: any) {
	return {
		runId: r._id,
		robotId: r.robot?._id ?? '',
		deckId: r.deckId ?? null,
		status: r.status ?? '',
		operatorName: r.operator?.username ?? '',
		cartridgeCount: r.plannedCartridgeCount ?? 0,
		durationMinutes: r.runStartTime && r.runEndTime
			? Math.round((new Date(r.runEndTime).getTime() - new Date(r.runStartTime).getTime()) / 60000)
			: null,
		date: r.runStartTime ?? r.createdAt ?? ''
	};
}

export const actions: Actions = {
	createDeck: async ({ request, locals }) => {
		await connectDB();
		const data = await request.formData();
		const deckId = data.get('deckId')?.toString()?.trim();
		if (!deckId) return fail(400, { error: 'Deck ID is required' });

		const existing = await Equipment.findById(deckId).lean();
		if (existing) return fail(400, { error: 'An equipment record with that ID already exists' });

		await Equipment.create({
			_id: deckId,
			name: deckId,
			equipmentType: 'deck',
			status: 'available'
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'INSERT',
			tableName: 'consumable_deck',
			recordId: deckId,
			changedBy: locals.user?.username ?? locals.user?._id,
			
			changedAt: new Date(),
			newData: {}
		});

		return { success: true, message: `Deck ${deckId} registered` };
	},

	createTray: async ({ request, locals }) => {
		await connectDB();
		const data = await request.formData();
		const trayId = data.get('trayId')?.toString()?.trim();
		if (!trayId) return fail(400, { error: 'Tray ID is required' });

		const existing = await Equipment.findById(trayId).lean();
		if (existing) return fail(400, { error: 'An equipment record with that ID already exists' });

		await Equipment.create({
			_id: trayId,
			name: trayId,
			equipmentType: 'cooling_tray',
			status: 'available'
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'INSERT',
			tableName: 'consumable_cooling_tray',
			recordId: trayId,
			changedBy: locals.user?.username ?? locals.user?._id,
			
			changedAt: new Date(),
			newData: {}
		});

		return { success: true, message: `Cooling tray ${trayId} registered` };
	},

	forceReleaseDeck: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const deckId = data.get('deckId')?.toString();
		const newStatus = data.get('newStatus')?.toString() ?? 'Available';
		const reason = data.get('reason')?.toString()?.trim();
		const password = data.get('password')?.toString();

		if (!deckId) return fail(400, { error: 'Deck ID is required' });
		if (!reason) return fail(400, { error: 'Reason is required' });
		if (!password) return fail(400, { error: 'Password is required' });

		// Verify password
		const user = await User.findById(locals.user._id).lean() as any;
		if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
			return fail(401, { error: 'Invalid password' });
		}

		await Equipment.findByIdAndUpdate(deckId, {
			status: statusToDb(newStatus),
			currentRobotId: null,
			lockoutUntil: null,
			assignedRunId: null
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'consumable_deck',
			recordId: deckId,
			changedBy: locals.user?.username ?? locals.user?._id,
			
			changedAt: new Date(),
			newData: {}
		});

		return { success: true, message: `Deck ${deckId} force-released to ${newStatus}` };
	},

	forceReleaseTray: async ({ request, locals }) => {
		if (!isAdmin(locals.user)) return fail(403, { error: 'Admin access required' });
		await connectDB();

		const data = await request.formData();
		const trayId = data.get('trayId')?.toString();
		const newStatus = data.get('newStatus')?.toString() ?? 'Available';
		const reason = data.get('reason')?.toString()?.trim();
		const password = data.get('password')?.toString();

		if (!trayId) return fail(400, { error: 'Tray ID is required' });
		if (!reason) return fail(400, { error: 'Reason is required' });
		if (!password) return fail(400, { error: 'Password is required' });

		// Verify password
		const user = await User.findById(locals.user._id).lean() as any;
		if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
			return fail(401, { error: 'Invalid password' });
		}

		await Equipment.findByIdAndUpdate(trayId, {
			status: statusToDb(newStatus),
			assignedRunId: null
		});

		await AuditLog.create({
			_id: generateId(),
			action: 'UPDATE',
			tableName: 'consumable_cooling_tray',
			recordId: trayId,
			changedBy: locals.user?.username ?? locals.user?._id,
			
			changedAt: new Date(),
			newData: {}
		});

		return { success: true, message: `Tray ${trayId} force-released to ${newStatus}` };
	}
};
