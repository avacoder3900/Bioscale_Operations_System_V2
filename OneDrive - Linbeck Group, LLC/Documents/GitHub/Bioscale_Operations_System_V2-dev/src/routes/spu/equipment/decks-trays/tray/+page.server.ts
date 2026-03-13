import { fail } from '@sveltejs/kit';
import { connectDB, Consumable, AuditLog, generateId } from '$lib/server/db';
import type { Actions } from './$types';

export const actions: Actions = {
	create: async ({ request, locals }) => {
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		const deckId = form.get('deckId')?.toString() || undefined;
		if (!name) return fail(400, { error: 'Name is required' });

		const id = generateId();
		await Consumable.create({
			_id: id, type: 'cooling_tray', status: 'active',
			currentRobotId: deckId
		});
		await AuditLog.create({
			_id: generateId(), tableName: 'consumables', recordId: id,
			action: 'INSERT', newData: { type: 'cooling_tray', name, deckId },
			changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	update: async ({ request, locals }) => {
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		const status = form.get('status')?.toString();
		const deckId = form.get('deckId')?.toString() || undefined;
		if (!id) return fail(400, { error: 'ID required' });

		await Consumable.updateOne({ _id: id, type: 'cooling_tray' }, { $set: { status, currentRobotId: deckId } });
		await AuditLog.create({
			_id: generateId(), tableName: 'consumables', recordId: id,
			action: 'UPDATE', newData: { status, deckId },
			changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	delete: async ({ request, locals }) => {
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'ID required' });

		await Consumable.deleteOne({ _id: id, type: 'cooling_tray' });
		await AuditLog.create({
			_id: generateId(), tableName: 'consumables', recordId: id,
			action: 'DELETE', changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	}
};
