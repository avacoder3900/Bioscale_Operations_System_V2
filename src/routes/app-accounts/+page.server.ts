import { fail, redirect } from '@sveltejs/kit';
import { hasPermission, requirePermission } from '$lib/server/permissions';
import { connectDB, AppUser, CustomerAccount, CartridgeOwnership, AppAccountBlock, Customer } from '$lib/server/db';
import { createDevAccount, isDevAccountId, settingsForMany } from '$lib/server/consumer/accounts';
import type { PageServerLoad, Actions } from './$types';

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Every consumer-app account (read-only mirror of `app_users`), with what
 * BIMS knows about each: customer links, cartridges owned, block state.
 * docs/CONSUMER-OWNERSHIP.md "Account management".
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	if (!locals.user) redirect(302, '/login');
	requirePermission(locals.user, 'customer:read');
	await connectDB();

	const q = (url.searchParams.get('q') ?? '').trim();
	const filter = url.searchParams.get('filter') ?? 'all';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const limit = 50;

	const query: Record<string, unknown> = {};
	if (q) {
		const re = new RegExp(escapeRegExp(q), 'i');
		query.$or = [{ signInEmail: re }, { bioscaleEmail: re }, { name: re }, { _id: re }];
	}

	const [users, total, blocks] = await Promise.all([
		AppUser.find(query).sort({ lastSignInAt: -1 }).skip((page - 1) * limit).limit(limit).lean() as Promise<any[]>,
		AppUser.countDocuments(query),
		AppAccountBlock.find().select('_id').lean() as Promise<any[]>
	]);
	const blocked = new Set(blocks.map((b) => b._id as string));
	const ids = users.map((u) => u._id as string);

	const [links, owned, settings] = await Promise.all([
		ids.length ? CustomerAccount.find({ accountId: { $in: ids }, status: 'active' }).select('accountId customerId role').lean() as Promise<any[]> : [],
		ids.length ? CartridgeOwnership.aggregate([
			{ $match: { accountId: { $in: ids }, open: true } },
			{ $group: { _id: '$accountId', count: { $sum: 1 } } }
		]) : [],
		settingsForMany(ids)
	]);
	const clinicIds = [...new Set([...settings.values()].map((s) => s.clinicAccountId).filter((id): id is string => Boolean(id)))];
	const clinicUsers = clinicIds.length ? (await AppUser.find({ _id: { $in: clinicIds } }).select('signInEmail name').lean()) as any[] : [];
	const clinicLabel = (id: string) => {
		const u = clinicUsers.find((c) => c._id === id);
		return u?.name ?? u?.signInEmail ?? id;
	};
	const customerIds = [...new Set(links.map((l) => l.customerId as string))];
	const customers = customerIds.length
		? (await Customer.find({ _id: { $in: customerIds } }).select('name').lean()) as any[]
		: [];
	const customerName = new Map(customers.map((c) => [c._id, c.name as string]));
	const ownedCount = new Map(owned.map((o: any) => [o._id as string, o.count as number]));

	let rows = users.map((u) => ({
		accountId: u._id as string,
		provider: u.provider ?? (u._id as string).split(':')[0],
		email: u.signInEmail ?? '',
		name: u.name ?? null,
		bioscaleEmail: u.bioscaleEmail ?? null,
		verified: Boolean(u.bioscaleEmailVerifiedAt),
		lastSignInAt: u.lastSignInAt ? new Date(u.lastSignInAt).toISOString() : null,
		createdAt: u.createdAt ? new Date(u.createdAt).toISOString() : null,
		customers: links.filter((l) => l.accountId === u._id).map((l) => ({
			customerId: l.customerId as string, name: customerName.get(l.customerId) ?? l.customerId, role: l.role as string
		})),
		owned: ownedCount.get(u._id as string) ?? 0,
		blocked: blocked.has(u._id as string),
		accountType: settings.get(u._id as string)?.accountType ?? 'individual',
		clinic: settings.get(u._id as string)?.clinicAccountId
			? { accountId: settings.get(u._id as string)!.clinicAccountId!, label: clinicLabel(settings.get(u._id as string)!.clinicAccountId!) }
			: null,
		dev: isDevAccountId(u._id as string)
	}));
	if (filter === 'unlinked') rows = rows.filter((r) => r.customers.length === 0);
	else if (filter === 'clinic') rows = rows.filter((r) => r.customers.some((c) => c.role !== 'member'));
	else if (filter === 'blocked') rows = rows.filter((r) => r.blocked);
	else if (filter === 'dev') rows = rows.filter((r) => r.dev);
	else if (filter === 'type-clinic') rows = rows.filter((r) => r.accountType === 'clinic');
	else if (filter === 'type-dev') rows = rows.filter((r) => r.accountType === 'dev');
	else if (filter === 'enrolled') rows = rows.filter((r) => r.clinic);

	return {
		q, filter, page, limit, total, blockedTotal: blocked.size, rows,
		removed: url.searchParams.has('removed'),
		canWrite: hasPermission(locals.user, 'customer:write')
	};
};

export const actions: Actions = {
	/**
	 * Create a dev account (temporary, see consumer/accounts.ts): an app
	 * account nobody signs in to, opened from its page with "view as", so staff
	 * can see the app from a user's point of view. Remove it from its page.
	 */
	createDev: async ({ request, locals }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const outcome = await createDevAccount({
			slug: String(fd.get('slug') ?? ''),
			name: String(fd.get('name') ?? ''),
			operator: { _id: locals.user._id, username: locals.user.username ?? locals.user._id }
		});
		if (!outcome.ok) return fail(400, { error: outcome.error });
		redirect(303, `/app-accounts/${encodeURIComponent(outcome.accountId)}`);
	}
};
