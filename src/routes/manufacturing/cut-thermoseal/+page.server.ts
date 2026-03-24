import { redirect, fail } from '@sveltejs/kit';
import { connectDB, AuditLog, PartDefinition, generateId } from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';
import mongoose from 'mongoose';

function getCollection() {
	return mongoose.connection.db!.collection('thermoseal_cutting_runs');
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const [runs, thermosealPart, settingsDoc] = await Promise.all([
		getCollection().find({}).sort({ createdAt: -1 }).limit(50).toArray(),
		PartDefinition.findOne({ partNumber: 'PT-CT-101' }).lean(),
		mongoose.connection.db!.collection('manufacturing_settings').findOne({ _id: 'default' })
	]);

	const defaultExpectedStrips = (settingsDoc as any)?.thermosealCutting?.expectedStripsPerRoll ?? 114;

	// Calculate total strips accepted (current inventory of cut strips)
	const allRuns = await getCollection().find({}).toArray();
	const totalStripsProduced = allRuns.reduce((sum: number, r: any) => sum + (r.acceptedCount ?? 0), 0);

	return {
		inventory: {
			rollStock: (thermosealPart as any)?.inventoryCount ?? 0,
			rollPartName: (thermosealPart as any)?.name ?? 'Thermoseal',
			totalStripsProduced
		},
		defaultExpectedStrips,
		runs: runs.map((r: any) => ({
			id: String(r._id),
			lotBarcode: r.lotBarcode ?? '—',
			expectedSheets: r.expectedSheets ?? 0,
			acceptedCount: r.acceptedCount ?? 0,
			rejectedCount: (r.expectedSheets ?? 0) - (r.acceptedCount ?? 0),
			operator: r.operator?.username ?? 'unknown',
			notes: r.notes ?? null,
			createdAt: r.createdAt ? new Date(r.createdAt).toISOString() : ''
		}))
	};
};

export const actions: Actions = {
	recordRun: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const lotBarcode = (data.get('lotBarcode') as string)?.trim();
		const expectedSheets = Number(data.get('expectedSheets') || 0);
		const acceptedCount = Number(data.get('acceptedCount') || 0);
		const notes = (data.get('notes') as string) || undefined;

		if (!lotBarcode) return fail(400, { error: 'Lot barcode is required — scan the roll first' });
		if (expectedSheets <= 0) return fail(400, { error: 'Expected strips must be > 0' });
		if (acceptedCount < 0) return fail(400, { error: 'Accepted count cannot be negative' });
		if (acceptedCount > expectedSheets) return fail(400, { error: 'Accepted cannot exceed expected' });

		const now = new Date();
		const runId = generateId();

		await getCollection().insertOne({
			_id: runId,
			lotBarcode,
			expectedSheets,
			acceptedCount,
			operator: { _id: locals.user._id, username: locals.user.username },
			notes: notes || null,
			status: 'completed',
			createdAt: now,
			updatedAt: now
		});

		// Consume 1 roll per cutting run
		const thermosealPartId = await resolvePartId('PT-CT-101');
		if (thermosealPartId) {
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: thermosealPartId,
				quantity: 1,
				manufacturingStep: 'cut_thermoseal',
				manufacturingRunId: runId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				lotId: lotBarcode,
				notes: `Cut thermoseal [${lotBarcode}]: 1 roll consumed → ${acceptedCount} strips accepted of ${expectedSheets} expected`
			});
		}

		await AuditLog.create({
			_id: generateId(),
			tableName: 'thermoseal_cutting_runs',
			recordId: runId,
			action: 'INSERT',
			changedBy: locals.user.username,
			changedAt: now,
			newData: { lotBarcode, expectedSheets, acceptedCount }
		});

		return { success: true };
	},

	/** Update default expected strips per roll — requires admin password */
	updateExpected: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();

		const data = await request.formData();
		const password = (data.get('adminPassword') as string)?.trim();
		const newValue = Number(data.get('newExpected') || 0);

		if (password !== 'admin123') return fail(403, { settingsError: 'Invalid admin password' });
		if (newValue <= 0) return fail(400, { settingsError: 'Value must be > 0' });

		await mongoose.connection.db!.collection('manufacturing_settings').updateOne(
			{ _id: 'default' },
			{ $set: { 'thermosealCutting.expectedStripsPerRoll': newValue, updatedAt: new Date() } },
			{ upsert: true }
		);

		await AuditLog.create({
			_id: generateId(),
			tableName: 'manufacturing_settings',
			recordId: 'default',
			action: 'UPDATE',
			changedBy: locals.user.username,
			changedAt: new Date(),
			newData: { 'thermosealCutting.expectedStripsPerRoll': newValue }
		});

		return { settingsSuccess: true };
	},

	/** Generate a test barcode for scanning */
	generateTestBarcode: async ({ locals }) => {
		if (!locals.user) redirect(302, '/login');
		const barcode = `THERM-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).substring(2, 6).toUpperCase()}`;
		return { testBarcode: barcode };
	}
};
