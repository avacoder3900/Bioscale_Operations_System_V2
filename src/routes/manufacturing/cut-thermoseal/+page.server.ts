import { redirect, fail } from '@sveltejs/kit';
import { connectDB, AuditLog, generateId } from '$lib/server/db';
import { recordTransaction, resolvePartId } from '$lib/server/services/inventory-transaction';
import type { PageServerLoad, Actions } from './$types';
import mongoose from 'mongoose';

function getCollection() {
	return mongoose.connection.db!.collection('thermoseal_cutting_runs');
}

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const runs = await getCollection()
		.find({})
		.sort({ createdAt: -1 })
		.limit(50)
		.toArray();

	return {
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

		const thermosealPartId = await resolvePartId('PT-CT-101');
		if (thermosealPartId) {
			await recordTransaction({
				transactionType: 'consumption',
				partDefinitionId: thermosealPartId,
				quantity: acceptedCount,
				manufacturingStep: 'cut_thermoseal',
				manufacturingRunId: runId,
				operatorId: locals.user._id,
				operatorUsername: locals.user.username,
				lotId: lotBarcode,
				notes: `Cut thermoseal [${lotBarcode}]: ${acceptedCount} accepted of ${expectedSheets} expected`
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
	}
};
