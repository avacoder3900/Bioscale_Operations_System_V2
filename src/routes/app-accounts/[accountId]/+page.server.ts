import { error, fail, redirect } from '@sveltejs/kit';
import { requirePermission } from '$lib/server/permissions';
import {
	connectDB, AppUser, AppSubject, AppAccountBlock, CustomerAccount, CartridgeOwnership, CartridgeRecord,
	ConsumerClaimAttempt, ConsumerInvite, Customer
} from '$lib/server/db';
import { linkAccountToCustomer, releaseOwnership, revokeCustomerLink } from '$lib/server/consumer/ownership';
import { blockAccount, unblockAccount } from '$lib/server/consumer/accounts';
import type { PageServerLoad, Actions } from './$types';

const ROLES = new Set(['admin', 'staff', 'member']);

/** One consumer-app account: who they are, what they belong to, what they own. */
export const load: PageServerLoad = async ({ locals, params }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'customer:read');
	await connectDB();
	const accountId = decodeURIComponent(params.accountId);

	const user = (await AppUser.findById(accountId).lean()) as any;
	if (!user) throw error(404, 'App account not found');

	const [block, links, rows, attempts, invites, customers] = await Promise.all([
		AppAccountBlock.findById(accountId).lean() as Promise<any>,
		CustomerAccount.find({ accountId }).sort({ linkedAt: -1 }).lean() as Promise<any[]>,
		CartridgeOwnership.find({ open: true, accountId }).sort({ claimedAt: -1 }).limit(500).lean() as Promise<any[]>,
		ConsumerClaimAttempt.find({ accountId }).sort({ at: -1 }).limit(50).lean() as Promise<any[]>,
		user.signInEmail
			? ConsumerInvite.find({ email: String(user.signInEmail).toLowerCase() }).sort({ createdAt: -1 }).limit(20).lean() as Promise<any[]>
			: [],
		Customer.find({ status: 'active' }).select('name customerType').sort({ name: 1 }).lean() as Promise<any[]>
	]);

	const customerIds = [...new Set([...links.map((l) => l.customerId), ...invites.map((i) => i.customerId), ...rows.map((r) => r.customerId)].filter(Boolean))];
	const named = customerIds.length ? (await Customer.find({ _id: { $in: customerIds } }).select('name').lean()) as any[] : [];
	const customerName = (id: string | null) => (id ? named.find((c) => c._id === id)?.name ?? id : null);

	// Cartridges the account's clinics own (visible to them in the app) are
	// listed separately from the account's personal rows.
	const clinicIds = links.filter((l) => l.status === 'active' && l.role !== 'member').map((l) => l.customerId as string);
	const clinicRows = clinicIds.length
		? (await CartridgeOwnership.find({ open: true, customerId: { $in: clinicIds } }).sort({ claimedAt: -1 }).limit(500).lean()) as any[]
		: [];
	const subjectIds = [...new Set([...rows, ...clinicRows].map((r) => r.subjectId).filter(Boolean))];
	const subjects = subjectIds.length ? (await AppSubject.find({ _id: { $in: subjectIds } }).select('displayName').lean()) as any[] : [];
	const subjectName = (id: string | null) => (id ? subjects.find((s) => s._id === id)?.displayName ?? id : null);
	const cartIds = [...new Set([...rows, ...clinicRows].map((r) => r.cartridgeId))];
	const carts = cartIds.length
		? (await CartridgeRecord.find({ _id: { $in: cartIds } }).select('status assayName reagentFilling.assayType.name statusUpdatedOn').lean()) as any[]
		: [];
	const cart = (id: string) => carts.find((c) => c._id === id);
	const shapeRow = (r: any) => ({
		id: r._id,
		cartridgeId: r.cartridgeId,
		status: cart(r.cartridgeId)?.status ?? null,
		assayName: cart(r.cartridgeId)?.assayName ?? cart(r.cartridgeId)?.reagentFilling?.assayType?.name ?? null,
		ranAt: cart(r.cartridgeId)?.statusUpdatedOn ?? null,
		source: r.source,
		matchedShipment: Boolean(r.matchedShipment),
		customerName: customerName(r.customerId ?? null),
		subjectName: subjectName(r.subjectId ?? null),
		claimedAt: r.claimedAt ? new Date(r.claimedAt).toISOString() : null
	});

	return {
		account: {
			accountId,
			provider: user.provider ?? accountId.split(':')[0],
			email: user.signInEmail ?? '',
			name: user.name ?? null,
			nameSource: user.nameSource ?? null,
			bioscaleEmail: user.bioscaleEmail ?? null,
			verifiedAt: user.bioscaleEmailVerifiedAt ? new Date(user.bioscaleEmailVerifiedAt).toISOString() : null,
			createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
			lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt).toISOString() : null
		},
		block: block ? { reason: block.reason, by: block.blockedBy?.username ?? null, at: new Date(block.blockedAt).toISOString() } : null,
		links: links.map((l) => ({
			id: l._id, customerId: l.customerId, customerName: customerName(l.customerId), role: l.role, status: l.status,
			linkedAt: l.linkedAt ? new Date(l.linkedAt).toISOString() : null, linkedBy: l.linkedBy?.label ?? null,
			revokedAt: l.revokedAt ? new Date(l.revokedAt).toISOString() : null
		})),
		owned: rows.map(shapeRow),
		clinicOwned: clinicRows.map(shapeRow),
		attempts: attempts.map((a) => ({ id: a._id, cartridgeId: a.cartridgeId ?? null, outcome: a.outcome, at: new Date(a.at).toISOString() })),
		invites: invites.map((i) => ({
			id: i._id, customerName: customerName(i.customerId), role: i.role, status: i.status,
			expiresAt: new Date(i.expiresAt).toISOString(), createdBy: i.createdBy?.label ?? null
		})),
		customers: customers.map((c) => ({ id: c._id, name: c.name, customerType: c.customerType ?? '' }))
	};
};

const operatorOf = (locals: App.Locals) => ({ _id: locals.user!._id, username: locals.user!.username ?? locals.user!._id });

export const actions: Actions = {
	link: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const accountId = decodeURIComponent(params.accountId);
		const fd = await request.formData();
		const customerId = String(fd.get('customerId') ?? '');
		const role = String(fd.get('role') ?? 'member');
		if (!customerId || !ROLES.has(role)) return fail(400, { error: 'Pick a customer and a role' });
		const [user, customer] = await Promise.all([AppUser.findById(accountId).select('signInEmail').lean() as Promise<any>, Customer.exists({ _id: customerId })]);
		if (!user || !customer) return fail(404, { error: 'Account or customer not found' });
		await linkAccountToCustomer({ accountId, customerId, role: role as 'admin' | 'staff' | 'member', email: user.signInEmail ?? null, operator: operatorOf(locals) });
		return { success: true, message: 'Linked' };
	},

	revoke: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const ok = await revokeCustomerLink({ linkId: String(fd.get('linkId') ?? ''), operator: operatorOf(locals) });
		return ok ? { success: true, message: 'Link revoked' } : fail(404, { error: 'Link not found' });
	},

	release: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const cartridgeId = String(fd.get('cartridgeId') ?? '');
		const note = String(fd.get('note') ?? '').trim() || 'Released from app account page';
		const op = operatorOf(locals);
		const outcome = await releaseOwnership({ cartridgeId, reason: 'operator', note, actor: { kind: 'operator', id: op._id, label: op.username } });
		return outcome.ok ? { success: true, message: 'Cartridge released' } : fail(404, { error: 'No open ownership on that cartridge' });
	},

	block: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const reason = String(fd.get('reason') ?? '').trim();
		if (!reason) return fail(400, { error: 'A reason is required to block an account' });
		await blockAccount({ accountId: decodeURIComponent(params.accountId), reason, operator: operatorOf(locals) });
		return { success: true, message: 'Account blocked — the app will refuse this sign-in from now on' };
	},

	unblock: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const ok = await unblockAccount({ accountId: decodeURIComponent(params.accountId), operator: operatorOf(locals) });
		return ok ? { success: true, message: 'Account unblocked' } : fail(404, { error: 'This account was not blocked' });
	}
};

export const config = { maxDuration: 60 };
