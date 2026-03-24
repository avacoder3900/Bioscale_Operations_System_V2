export const config = { maxDuration: 60 };
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, Equipment, WaxFillingRun, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import { isAdmin, requirePermission } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	await connectDB();
	const deckId = url.searchParams.get('id') ?? '';

	const deck = deckId ? await Equipment.findOne({ _id: deckId, equipmentType: 'deck' }).lean() : null;

	// Runs that used this deck
	const runs = deckId ? await WaxFillingRun.find({ deckId }).sort({ createdAt: -1 }).limit(50).lean() : [];

	// Cartridges filled on this deck
	const cartridges = deckId ? await CartridgeRecord.find({ 'waxFilling.deckId': deckId }).lean() : [];

	const accepted = cartridges.filter((c: any) => c.waxQc?.status === 'Accepted').length;
	const rejected = cartridges.filter((c: any) => c.waxQc?.status === 'Rejected').length;
	const total = accepted + rejected;
	const operators = new Set(cartridges.map((c: any) => c.waxFilling?.operator?.username).filter(Boolean));

	// Position stats
	const positionMap = new Map<number, { total: number; accepted: number; rejected: number }>();
	for (const c of cartridges as any[]) {
		const pos = c.waxFilling?.deckPosition;
		if (pos == null) continue;
		const entry = positionMap.get(pos) ?? { total: 0, accepted: 0, rejected: 0 };
		entry.total++;
		if (c.waxQc?.status === 'Accepted') entry.accepted++;
		if (c.waxQc?.status === 'Rejected') entry.rejected++;
		positionMap.set(pos, entry);
	}

	return {
		deckId,
		deck: deck ? {
			status: (deck as any).status === 'available' ? 'Available' : (deck as any).status === 'in_use' ? 'In Use' : (deck as any).status ?? 'Unknown',
			createdAt: (deck as any).createdAt ?? null,
			lastUsed: (deck as any).lastUsed ?? null,
			lockoutUntil: (deck as any).lockoutUntil ?? null,
			totalRuns: runs.length
		} : null,
		stats: {
			totalRuns: runs.length,
			totalFills: cartridges.length,
			acceptanceRate: total > 0 ? accepted / total : 1,
			uniqueOperators: operators.size,
			heatingEvents: 0
		},
		positionStats: Array.from(positionMap.entries()).map(([pos, s]) => ({
			position: pos,
			totalFills: s.total,
			acceptedCount: s.accepted,
			rejectedCount: s.rejected,
			successRate: s.total > 0 ? s.accepted / s.total : 0
		})),
		runs: (runs as any[]).map((r: any) => ({
			runId: r._id,
			robotId: r.robot?._id ?? '',
			operatorName: r.operator?.username ?? '—',
			status: r.status,
			waxSourceLot: r.waxSourceLot ?? null,
			waxTubeId: r.waxTubeId ?? null,
			plannedCartridgeCount: r.plannedCartridgeCount ?? 0,
			coolingTrayId: r.coolingTrayId ?? null,
			startTime: r.runStartTime ?? r.createdAt,
			endTime: r.runEndTime ?? null
		})),
		cartridges: (cartridges as any[]).slice(0, 100).map((c: any) => ({
			cartridgeId: c._id,
			waxRunId: c.waxFilling?.runId ?? null,
			deckPosition: c.waxFilling?.deckPosition ?? null,
			qcStatus: c.waxQc?.status ?? 'Pending',
			rejectionReason: c.waxQc?.rejectionReason ?? null,
			transferTimeSeconds: c.waxFilling?.transferTimeSeconds ?? null,
			currentInventory: c.status ?? 'unknown'
		})),
		cartridgesByRun: (() => {
			const m: Record<string, any[]> = {};
			for (const c of cartridges as any[]) {
				const rid = c.waxFilling?.runId;
				if (!rid) continue;
				if (!m[rid]) m[rid] = [];
				m[rid].push({
					cartridgeId: c._id,
					waxRunId: rid,
					deckPosition: c.waxFilling?.deckPosition ?? null,
					qcStatus: c.waxQc?.status ?? 'Pending',
					rejectionReason: c.waxQc?.rejectionReason ?? null,
					transferTimeSeconds: c.waxFilling?.transferTimeSeconds ?? null,
					currentInventory: c.status ?? 'unknown'
				});
			}
			return m;
		})(),
		heatingHistory: [],
		operators: Array.from(operators).map(name => ({
			operatorName: name,
			totalRuns: (cartridges as any[]).filter((c: any) => c.waxFilling?.operator?.username === name).length,
			acceptedCount: (cartridges as any[]).filter((c: any) => c.waxFilling?.operator?.username === name && c.waxQc?.status === 'Accepted').length,
			rejectedCount: (cartridges as any[]).filter((c: any) => c.waxFilling?.operator?.username === name && c.waxQc?.status === 'Rejected').length
		})),
		isAdmin: isAdmin(locals.user)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Name is required' });

		const id = generateId();
		await Equipment.create({ _id: id, name: id, equipmentType: 'deck', status: 'available' });
		await AuditLog.create({
			_id: generateId(), tableName: 'equipment', recordId: id,
			action: 'INSERT', changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	update: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		const status = form.get('status')?.toString();
		if (!id) return fail(400, { error: 'ID required' });

		await Equipment.updateOne({ _id: id, equipmentType: 'deck' }, { $set: { status } });
		await AuditLog.create({
			_id: generateId(), tableName: 'equipment', recordId: id,
			action: 'UPDATE', newData: { status }, changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'ID required' });

		await Equipment.deleteOne({ _id: id, equipmentType: 'deck' });
		await AuditLog.create({
			_id: generateId(), tableName: 'equipment', recordId: id,
			action: 'DELETE', changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	}
};
