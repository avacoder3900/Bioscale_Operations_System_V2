import { fail } from '@sveltejs/kit';
import { connectDB, Consumable, AuditLog, generateId } from '$lib/server/db';
import { requirePermission } from '$lib/server/permissions';
import type { Actions } from './$types';

export const actions: Actions = {
	create: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		const form = await request.formData();
		const name = form.get('name')?.toString().trim();
		if (!name) return fail(400, { error: 'Name is required' });

		const id = generateId();
		await Consumable.create({ _id: id, type: 'deck', status: 'active' });
		await AuditLog.create({
			_id: generateId(), tableName: 'consumables', recordId: id,
			action: 'INSERT', newData: { type: 'deck', name },
			changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	update: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		const status = form.get('status')?.toString();
		if (!id) return fail(400, { error: 'ID required' });

		await Consumable.updateOne({ _id: id, type: 'deck' }, { $set: { status } });
		await AuditLog.create({
			_id: generateId(), tableName: 'consumables', recordId: id,
			action: 'UPDATE', newData: { status },
			changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	},

	delete: async ({ request, locals }) => {
		requirePermission(locals.user, 'equipment:write');
		await connectDB();
		const form = await request.formData();
		const id = form.get('id')?.toString();
		if (!id) return fail(400, { error: 'ID required' });

		await Consumable.deleteOne({ _id: id, type: 'deck' });
		await AuditLog.create({
			_id: generateId(), tableName: 'consumables', recordId: id,
			action: 'DELETE', changedAt: new Date(), changedBy: locals.user?.username ?? 'system'
		});
		return { success: true };
	}
};
