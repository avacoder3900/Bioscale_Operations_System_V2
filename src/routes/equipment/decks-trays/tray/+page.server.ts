export const config = { maxDuration: 60 };
import { fail, redirect } from '@sveltejs/kit';
import { connectDB, Equipment, WaxFillingRun, CartridgeRecord, AuditLog, generateId } from '$lib/server/db';
import { isAdmin } from '$lib/server/permissions';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ url, locals }) => {
	await connectDB();
	const trayId = url.searchParams.get('id') ?? '';

	const tray = trayId ? await Equipment.findOne({ _id: trayId, equipmentType: 'cooling_tray' }).lean() : null;

	// Runs that used this tray
	const runs = trayId ? await WaxFillingRun.find({ coolingTrayId: trayId }).sort({ createdAt: -1 }).limit(50).lean() : [];

	// Cartridges cooled on this tray
	const cartridges = trayId ? await CartridgeRecord.find({ 'waxStorage.coolingTrayId': trayId }).lean() : [];

	const accepted = cartridges.filter((c: any) => c.waxQc?.status === 'Accepted').length;
	const rejected = cartridges.filter((c: any) => c.waxQc?.status === 'Rejected').length;
	const total = accepted + rejected;

	return {
		trayId,
		tray: tray ? {
			status: (tray as any).status === 'available' ? 'Available' : (tray as any).status === 'in_use' ? 'In Use' : (tray as any).status ?? 'Unknown',
			createdAt: (tray as any).createdAt ?? null,
			assignedRunId: (tray as any).assignedRunId ?? null,
			totalRuns: runs.length
		} : null,
		stats: {
			totalRuns: runs.length,
			totalCooled: cartridges.length,
			acceptanceRate: total > 0 ? accepted / total : 1
		},
		runs: (runs as any[]).map((r: any) => ({
			runId: r._id,
			robotId: r.robot?._id ?? '',
			operatorName: r.operator?.username ?? '—',
			status: r.status,
			startTime: r.runStartTime ?? r.createdAt,
			endTime: r.runEndTime ?? null,
			cartridgeCount: r.cartridgeIds?.length ?? 0
		})),
		cartridges: (cartridges as any[]).slice(0, 100).map((c: any) => ({
			cartridgeId: c._id,
			qcStatus: c.waxQc?.status ?? 'Pending',
			storedAt: c.waxStorage?.timestamp ?? null,
			location: c.waxStorage?.location ?? null,
			currentPhase: c.currentPhase ?? 'unknown'
		})),
		isAdmin: isAdmin(locals.user)
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Name is required' });

		const id = generateId();
		await Equipment.create({ _id: id, name: id, equipmentType: 'cooling_tray', status: 'available' });
		await AuditLog.create({
			_id: generateId(), tableName: 'equipment', recordId: id,
			action: 'INSERT', changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	delete: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'ID required' });

		await Equipment.deleteOne({ _id: id, equipmentType: 'cooling_tray' });
		await AuditLog.create({
			_id: generateId(), tableName: 'equipment', recordId: id,
			action: 'DELETE', changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	}
};
