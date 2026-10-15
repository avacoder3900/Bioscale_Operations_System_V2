import { fail, redirect, error } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { connectDB, Customer, Spu, AuditLog, CustomerAccount, ConsumerInvite, AppUser, CartridgeOwnership } from '$lib/server/db';
import { generateId } from '$lib/server/db/utils.js';
import { requirePermission } from '$lib/server/permissions';
import { createInvite, normalizeEmail } from '$lib/server/consumer/ownership';
import type { PageServerLoad, Actions } from './$types';

const APP_ROLES = new Set(['admin', 'staff', 'member']);

/** Where the consumer app lives, for the invite link shown to the operator. */
const appBaseUrl = () => (env.BIOSCALE_APP_URL || 'https://www.bioscale.app').replace(/\/$/, '');

export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'customer:read');
	await connectDB();

	const customer = await Customer.findById(params.id).lean() as any;
	if (!customer) error(404, 'Customer not found');

	const [assignedSpus, accountLinks, pendingInvites, ownedCount] = await Promise.all([
		Spu.find({ 'assignment.customer._id': params.id })
			.select({ _id: 1, udi: 1, deviceState: 1, qcStatus: 1, createdAt: 1, 'assignment.type': 1 })
			.lean(),
		CustomerAccount.find({ customerId: params.id, status: 'active' }).sort({ linkedAt: 1 }).lean() as Promise<any[]>,
		ConsumerInvite.find({ customerId: params.id, status: 'pending', expiresAt: { $gt: new Date() } })
			.sort({ createdAt: -1 }).lean() as Promise<any[]>,
		CartridgeOwnership.countDocuments({ customerId: params.id, open: true })
	]);

	// Consumer-app accounts linked to this customer, labelled from app_users
	// (read-only mirror) — the app's own profile store.
	const appUsers = accountLinks.length
		? (await AppUser.find({ _id: { $in: accountLinks.map((l) => l.accountId) } })
			.select('signInEmail name lastSignInAt').lean()) as any[]
		: [];
	const userById = new Map(appUsers.map((u) => [u._id, u]));
	const appAccess = {
		accounts: accountLinks.map((l) => ({
			id: l._id,
			accountId: l.accountId,
			email: userById.get(l.accountId)?.signInEmail ?? l.email ?? '',
			name: userById.get(l.accountId)?.name ?? null,
			role: l.role,
			linkedAt: l.linkedAt ? new Date(l.linkedAt).toISOString() : null,
			lastSignInAt: userById.get(l.accountId)?.lastSignInAt
				? new Date(userById.get(l.accountId).lastSignInAt).toISOString() : null
		})),
		invites: pendingInvites.map((i) => ({
			id: i._id,
			email: i.email,
			role: i.role,
			expiresAt: new Date(i.expiresAt).toISOString(),
			createdBy: i.createdBy?.label ?? null
		})),
		ownedCartridges: ownedCount,
		appBaseUrl: appBaseUrl()
	};

	const customerNotes = (customer.notes ?? []).map((n: any) => ({
		id: n._id,
		content: n.noteText ?? '',
		createdAt: n.createdAt,
		createdByUsername: n.createdBy?.username ?? 'Unknown'
	}));

	return {
		customer: {
			id: customer._id,
			name: customer.name,
			customerType: customer.customerType ?? '',
			status: customer.status ?? 'active',
			contactEmail: customer.contactEmail ?? null,
			contactPhone: customer.contactPhone ?? null,
			contactName: customer.contactName ?? null,
			address: customer.address ?? null,
			createdAt: customer.createdAt,
			updatedAt: customer.updatedAt,
			notes: customerNotes
		},
		spus: (assignedSpus as any[]).map((s) => ({
			id: s._id,
			udi: s.udi,
			shortId: typeof s._id === 'string' ? s._id.slice(0, 8) : String(s._id ?? '').slice(0, 8),
			deviceState: s.deviceState ?? 'unknown',
			qcStatus: s.qcStatus ?? 'pending',
			createdAt: s.createdAt ?? null,
			assignmentType: s.assignment?.type ?? ''
		})),
		notes: customerNotes,
		appAccess,
		orderHistory: [] as {
			id: string;
			orderNumber: string;
			status: string;
			createdAt: Date;
			barcode: string | null;
			cartridgeCount: number;
			trackingNumber: string | null;
			carrier: string | null;
			shippedAt: Date | null;
		}[]
	};
};

export const actions: Actions = {
	update: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
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

		return { success: true, message: 'Customer updated successfully' };
	},

	addNote: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
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

		return { success: true, message: "Operation completed successfully" };
	},

	deactivate: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		await Customer.updateOne({ _id: params.id }, { $set: { status: 'inactive' } });

		await AuditLog.create({
			tableName: 'customers', recordId: params.id, action: 'UPDATE',
			newData: { status: 'inactive' }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true, message: "Operation completed successfully" };
	},

	/**
	 * Consumer-app access (docs/CONSUMER-OWNERSHIP.md): invite an app account
	 * to this customer. The token is shown once as a link for the operator to
	 * send; BIMS keeps only its hash. Accepting happens in the app.
	 */
	inviteApp: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const email = normalizeEmail(String(fd.get('email') ?? ''));
		const role = String(fd.get('role') ?? 'member');
		if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail(400, { error: 'A valid email is required' });
		if (!APP_ROLES.has(role)) return fail(400, { error: 'Role must be admin, staff or member' });

		const { token, expiresAt } = await createInvite({
			customerId: params.id, email, role: role as 'admin' | 'staff' | 'member',
			actor: { kind: 'operator', id: locals.user._id, label: locals.user.username ?? locals.user._id }
		});
		return {
			success: true,
			message: `Invite created for ${email}`,
			inviteLink: `${appBaseUrl()}/invite/${token}`,
			inviteEmail: email,
			inviteExpiresAt: expiresAt.toISOString()
		};
	},

	revokeInvite: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const inviteId = String(fd.get('inviteId') ?? '');
		const res = await ConsumerInvite.updateOne(
			{ _id: inviteId, customerId: params.id, status: 'pending' },
			{ $set: { status: 'revoked', revokedAt: new Date() } }
		);
		if (!res.matchedCount) return fail(404, { error: 'Invite not found' });
		await AuditLog.create({
			_id: generateId(), tableName: 'consumer_invites', recordId: inviteId, action: 'REVOKE',
			changedBy: locals.user.username ?? locals.user._id, changedAt: new Date()
		});
		return { success: true, message: 'Invite revoked' };
	},

	revokeApp: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const linkId = String(fd.get('linkId') ?? '');
		const now = new Date();
		const res = await CustomerAccount.updateOne(
			{ _id: linkId, customerId: params.id, status: 'active' },
			{ $set: { status: 'revoked', revokedAt: now, revokedBy: { kind: 'operator', id: locals.user._id, label: locals.user.username ?? locals.user._id } } }
		);
		if (!res.matchedCount) return fail(404, { error: 'Account link not found' });
		await AuditLog.create({
			_id: generateId(), tableName: 'customer_accounts', recordId: linkId, action: 'REVOKE',
			changedBy: locals.user.username ?? locals.user._id, changedAt: now, newData: { customerId: params.id }
		});
		return { success: true, message: 'App access revoked' };
	},

	reactivate: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		await Customer.updateOne({ _id: params.id }, { $set: { status: 'active' } });

		await AuditLog.create({
			tableName: 'customers', recordId: params.id, action: 'UPDATE',
			newData: { status: 'active' }, changedBy: locals.user.username ?? locals.user._id
		});

		return { success: true, message: "Operation completed successfully" };
	}
};

export const config = { maxDuration: 60 };
