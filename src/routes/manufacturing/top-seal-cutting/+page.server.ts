import { redirect, fail } from '@sveltejs/kit';
import { connectDB, AuditLog, PartDefinition, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';
import mongoose from 'mongoose';

function getCollection() {
	return mongoose.connection.db!.collection('top_seal_cutting_runs');
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'manufacturing:read');
	await connectDB();

	const [runs, topSealPart, settingsDoc] = await Promise.all([
		getCollection().find({}).sort({ createdAt: -1 }).limit(50).toArray(),
		PartDefinition.findOne({ partNumber: 'PT-CT-103' }).lean(),
		mongoose.connection.db!.collection('manufacturing_settings').findOne({ _id: 'default' })
	]);

	const defaultExpectedStrips = (settingsDoc as any)?.topSealCutting?.expectedStripsPerRoll ?? 30;
	const allRuns = await getCollection().find({}).toArray();
	const totalStripsProduced = allRuns.reduce((sum: number, r: any) => sum + (r.acceptedCount ?? 0), 0);

	return {
		inventory: {
			rollStock: (topSealPart as any)?.inventoryCount ?? 0,
			rollPartName: (topSealPart as any)?.name ?? 'Top Seal',
			totalStripsProduced
		},
		defaultExpectedStrips,
		runs: runs.map((r: any) => ({
			id: String(r._id),
			lotBarcode: r.lotBarcode ?? '—',
			expectedSheets: r.expectedSheets ?? 0,
			cutCount: r.cutCount ?? 0,
			acceptedCount: r.acceptedCount ?? 0,
			rejectedCount: (r.cutCount ?? 0) - (r.acceptedCount ?? 0),
			operator: r.operator?.username ?? 'unknown',
			notes: r.notes ?? null,
			status: r.status ?? 'completed',
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : ''
		}))
	};
};

export const actions: Actions = {
	updateExpected: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();
		const data = await request.formData();
		const password = (data.get('adminPassword') as string)?.trim();
		const newValue = Number(data.get('newExpected') || 0);
		if (password !== 'admin123') return fail(403, { settingsError: 'Invalid admin password' });
		if (newValue <= 0) return fail(400, { settingsError: 'Value must be > 0' });
		await mongoose.connection.db!.collection('manufacturing_settings').updateOne(
			{ _id: 'default' },
			{ $set: { 'topSealCutting.expectedStripsPerRoll': newValue, updatedAt: new Date() } },
			{ upsert: true }
		);
		await AuditLog.create({ _id: generateId(), tableName: 'manufacturing_settings', recordId: 'default', action: 'UPDATE', changedBy: locals.user.username, changedAt: new Date(), newData: { 'topSealCutting.expectedStripsPerRoll': newValue } });
		return { settingsSuccess: true };
	},

	generateTestBarcode: async ({ locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		const barcode = `TSEAL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
		return { testBarcode: barcode };
	},

	recordRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'manufacturing:write');
		await connectDB();

		const data = await request.formData();
		const lotBarcode = (data.get('lotBarcode') as string)?.trim();
		const expectedSheets = Number(data.get('expectedSheets') || 0);
		const cutCount = Number(data.get('cutCount') || 0);
		const acceptedCount = Number(data.get('acceptedCount') || 0);
		const notes = (data.get('notes') as string) || undefined;

		if (!lotBarcode) return fail(400, { error: 'Lot barcode is required — scan the roll first' });
		if (expectedSheets <= 0) return fail(400, { error: 'Expected sheets must be > 0' });
		if (cutCount <= 0) return fail(400, { error: 'Cut count must be > 0' });
		if (acceptedCount < 0) return fail(400, { error: 'Accepted count cannot be negative' });
		if (acceptedCount > cutCount) return fail(400, { error: 'Accepted count cannot exceed cut count' });

		const now = new Date();
		const runId = generateId();

		await getCollection().insertOne({
			_id: runId,
			lotBarcode,
			expectedSheets,
			cutCount,
			acceptedCount,
			operator: { _id: locals.user._id, username: locals.user.username },
			notes: notes || null,
			status: 'completed',
			createdAt: now,
			updatedAt: now
		});

		const topSealPartId = await resolvePartId('PT-CT-103');
		if (topSealPartId) {
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: topSealPartId,
				quantity: 1,
				manufacturingStep: 'cut_top_seal',
				manufacturingRunId: runId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				lotId: lotBarcode,
				notes: `Cut top seal [${lotBarcode}]: ${acceptedCount} accepted of ${cutCount} cut (${expectedSheets} sheets expected)`
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'top_seal_cutting_runs',
			recordId: runId,
			action: 'INSERT',
			changedBy: locals.user.username,
			changedAt: now,
			newData: { lotBarcode, expectedSheets, cutCount, acceptedCount }
		});

		return { success: true };
	}
};
