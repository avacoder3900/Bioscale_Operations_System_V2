import { fail, redirect, error } from '@sveltejs/kit';
import { connectDB, Customer, Spu, AuditLog } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import type { PageServerLoad, Actions } from './$types';

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	await connectDB();

	const customer = await Customer.findById(params.id).lean() as any;
	if (!customer) error(404, 'Customer not found');

	const assignedSpus = await Spu.find({ 'assignment.customer._id': params.id })
		.select({ _id: 1, udi: 1, deviceState: 1, 'assignment.type': 1 })
		.lean();

	return {
		customer: {
			id: customer._id,
			name: customer.name,
			customerType: customer.customerType ?? '',
			status: customer.status ?? 'active',
			contactEmail: customer.contactEmail ?? null,
			contactPhone: customer.contactPhone ?? null,
			address: customer.address ?? null,
			notes: null, // top-level notes field (not the array)
			createdAt: customer.createdAt,
			updatedAt: customer.updatedAt
		},
		assignedSpus: (assignedSpus as any[]).map((s) => ({
			id: s._id,
			udi: s.udi,
			deviceState: s.deviceState ?? 'unknown',
			assignmentType: s.assignment?.type ?? ''
		})),
		customerNotes: (customer.notes ?? []).map((n: any) => ({
			id: n._id,
			content: n.noteText ?? '',
			createdAt: n.createdAt,
			createdByUsername: n.createdBy?.username ?? 'Unknown'
		}))
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const fd = await request.formData();
		const name = fd.get('name') as string;
		if (!name?.trim()) return fail(400, { error: 'Name is required' });

		await Customer.updateOne({ _id: params.id }, {
			$set: {
				name: name.trim(),
				customerType: fd.get('customerType') || undefined,
				contactEmail: fd.get('contactEmail') || null,
				contactPhone: fd.get('contactPhone') || null,
				address: fd.get('address') || null
			}
		});

		await AuditLog.create({
			tableName: 'customers', recordId: params.id, action: 'UPDATE',
			newData: { name: name.trim() }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true };
	},

	addNote: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		const fd = await request.formData();
		const content = fd.get('content') as string;
		if (!content?.trim()) return fail(400, { error: 'Content is required' });

		await Customer.updateOne({ _id: params.id }, {
			$push: {
				notes: {
					_id: generateId(),
					noteText: content.trim(),
					createdBy: { _id: locals.user._id, username: locals.user.username },
					createdAt: new Date()
				}
			}
		});

		return { success: true };
	},

	deactivate: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		await Customer.updateOne({ _id: params.id }, { $set: { status: 'inactive' } });

		await AuditLog.create({
			tableName: 'customers', recordId: params.id, action: 'UPDATE',
			newData: { status: 'inactive' }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true };
	},

	reactivate: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		await connectDB();
		await Customer.updateOne({ _id: params.id }, { $set: { status: 'active' } });

		await AuditLog.create({
			tableName: 'customers', recordId: params.id, action: 'UPDATE',
			newData: { status: 'active' }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true };
	}
};
