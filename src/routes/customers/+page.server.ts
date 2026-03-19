import { fail, redirect } from '@sveltejs/kit';
import { connectDB, Customer, Spu, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const customers = await Customer.find().sort({ name: 1 }).lean();

	// Get SPU counts per customer
	const spuCounts = await Spu.aggregate([
		{ $match: { 'assignment.customer._id': { $ne: null } } },
		{ $group: { _id: '$assignment.customer._id', count: { $sum: 1 } } }
	]);
	const countMap = new Map(spuCounts.map((s: any) => [s._id, s.count]));

	return {
		customers: customers.map((c: any) => ({
			id: c._id,
			name: c.name,
			customerType: c.customerType ?? '',
			status: c.status ?? 'active',
			contactEmail: c.contactEmail ?? null,
			contactName: c.contactName ?? null,
			contactPhone: c.contactPhone ?? null,
			createdAt: c.createdAt,
			spuCount: countMap.get(c._id) ?? 0
		}))
	};
};

export const actions: Actions = {
	create: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const fd = await request.formData();
		const name = fd.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Name is required' });

		const customerId = generateId();
		await Customer.create({
			_id: customerId,
			name: name.trim(),
			customerType: fd.get('customerType') || 'external',
			contactEmail: fd.get('contactEmail') || undefined,
			contactPhone: fd.get('contactPhone') || undefined,
			address: fd.get('address') || undefined,
			notes: fd.get('notes') ? [{
				_id: generateId(),
				noteText: fd.get('notes') as string,
				createdBy: { _id: locals.user._id, username: locals.user.username },
				createdAt: new Date()
			}] : []
		});

		await AuditLog.create({
			tableName: 'customers', recordId: customerId, action: 'INSERT',
			newData: { name: name.trim() }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true, message: "Customer created successfully" };
	}
};
