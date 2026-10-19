import { error, fail, redirect } from '@sveltejs/kit';
import { hasPermission, isAdmin, requirePermission } from '$lib/server/permissions';
import {
	connectDB, AppUser, AppSubject, AppAccountBlock, CustomerAccount, CartridgeOwnership, CartridgeRecord,
	ConsumerInvite, Customer
} from '$lib/server/db';
import { assignOwnership, linkAccountToCustomer, releaseOwnership, revokeCustomerLink } from '$lib/server/consumer/ownership';
import {
	blockAccount, clinicAccountIds, deleteDevAccount, enrolledUnder, enrollInClinic, isDevAccountId, removeFromClinic,
	setAccountType, setResultsEmail, settingsFor, unblockAccount
} from '$lib/server/consumer/accounts';
import { mintViewAsToken, viewAsConfigured, viewAsUrl } from '$lib/server/consumer/view-as';
import { CARTRIDGE_ID } from '$lib/server/consumer/http';
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

	const [block, links, rows, invites, customers, settings, enrolledIds, allClinicIds] = await Promise.all([
		AppAccountBlock.findById(accountId).lean() as Promise<any>,
		CustomerAccount.find({ accountId }).sort({ linkedAt: -1 }).lean() as Promise<any[]>,
		CartridgeOwnership.find({ open: true, accountId }).sort({ claimedAt: -1 }).limit(500).lean() as Promise<any[]>,
		user.signInEmail
			? ConsumerInvite.find({ email: String(user.signInEmail).toLowerCase() }).sort({ createdAt: -1 }).limit(20).lean() as Promise<any[]>
			: [],
		Customer.find({ status: 'active' }).select('name customerType').sort({ name: 1 }).lean() as Promise<any[]>,
		settingsFor(accountId),
		enrolledUnder(accountId),
		clinicAccountIds()
	]);

	// Account type and clinic enrollment (consumer/accounts.ts): names for the
	// clinic picker, the clinic this account is enrolled under, and its enrollees.
	const peopleIds = [...new Set([...allClinicIds, ...enrolledIds, ...(settings.clinicAccountId ? [settings.clinicAccountId] : [])])];
	const [people, enrolledOwned] = await Promise.all([
		peopleIds.length ? AppUser.find({ _id: { $in: peopleIds } }).select('signInEmail name').lean() as Promise<any[]> : [],
		enrolledIds.length ? CartridgeOwnership.aggregate([
			{ $match: { accountId: { $in: enrolledIds }, open: true } },
			{ $group: { _id: '$accountId', count: { $sum: 1 } } }
		]) : []
	]);
	const personLabel = (id: string) => {
		const p = people.find((u) => u._id === id);
		return p ? (p.name ? `${p.name} (${p.signInEmail ?? id})` : (p.signInEmail ?? id)) : id;
	};

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
		claimedAt: r.claimedAt ? new Date(r.claimedAt).toISOString() : null,
		claimedBy: r.claimedBy?.label ?? null
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
			lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt).toISOString() : null,
			isDev: isDevAccountId(accountId),
			devCreatedBy: user.devAccount?.createdBy?.username ?? null
		},
		viewAs: viewAsConfigured(),
		accountType: settings.accountType,
		clinic: settings.clinicAccountId ? { accountId: settings.clinicAccountId, label: personLabel(settings.clinicAccountId) } : null,
		clinicOptions: allClinicIds.filter((id) => id !== accountId && people.some((u) => u._id === id))
			.map((id) => ({ accountId: id, label: personLabel(id) }))
			.sort((x, y) => x.label.localeCompare(y.label)),
		enrolled: enrolledIds.map((id) => ({
			accountId: id, label: personLabel(id),
			owned: (enrolledOwned as any[]).find((o) => o._id === id)?.count ?? 0
		})).sort((x, y) => x.label.localeCompare(y.label)),
		isAdmin: isAdmin(locals.user),
		canWrite: hasPermission(locals.user, 'customer:write'),
		block: block ? { reason: block.reason, by: block.blockedBy?.username ?? null, at: new Date(block.blockedAt).toISOString() } : null,
		links: links.map((l) => ({
			id: l._id, customerId: l.customerId, customerName: customerName(l.customerId), role: l.role, status: l.status,
			linkedAt: l.linkedAt ? new Date(l.linkedAt).toISOString() : null, linkedBy: l.linkedBy?.label ?? null,
			revokedAt: l.revokedAt ? new Date(l.revokedAt).toISOString() : null
		})),
		owned: rows.map(shapeRow),
		clinicOwned: clinicRows.map(shapeRow),
		invites: invites.map((i) => ({
			id: i._id, customerName: customerName(i.customerId), role: i.role, status: i.status,
			expiresAt: new Date(i.expiresAt).toISOString(), createdBy: i.createdBy?.label ?? null
		})),
		customers: customers.map((c) => ({ id: c._id, name: c.name, customerType: c.customerType ?? '' }))
	};
};

const MAX_BULK_ASSIGN = 200;
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Cartridge ids from scanner input: split on newlines, spaces, commas or
 * semicolons; a token that carries a UUID (e.g. a QR URL) is reduced to it;
 * duplicates dropped, order kept.
 */
function parseScannedIds(raw: string): string[] {
	const ids = raw.split(/[\s,;]+/).map((t) => t.trim()).filter(Boolean)
		.map((t) => t.match(UUID)?.[0].toLowerCase() ?? t);
	return [...new Set(ids)];
}

const operatorOf = (locals: App.Locals) => ({ _id: locals.user!._id, username: locals.user!.username ?? locals.user!._id });

export const actions: Actions = {
	/** Set or clear the results (Bioscale) email; written verified — staff vouch for it. */
	setEmail: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const fd = await request.formData();
		const outcome = await setResultsEmail({
			accountId: decodeURIComponent(params.accountId), email: String(fd.get('email') ?? ''), operator: operatorOf(locals)
		});
		return outcome.ok ? { success: true, message: outcome.message } : fail(400, { error: outcome.error });
	},

	/** Individual / Clinic / Dev. Dev (every user's results) needs a BIMS admin. */
	setType: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const accountId = decodeURIComponent(params.accountId);
		if (!(await AppUser.exists({ _id: accountId }))) return fail(404, { error: 'Account not found' });
		const fd = await request.formData();
		const outcome = await setAccountType({
			accountId, accountType: String(fd.get('accountType') ?? ''), operator: operatorOf(locals), isAdmin: isAdmin(locals.user)
		});
		return outcome.ok ? { success: true, message: outcome.message } : fail(400, { error: outcome.error });
	},

	/** Enroll this (individual) account under a clinic account. */
	enroll: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const accountId = decodeURIComponent(params.accountId);
		if (!(await AppUser.exists({ _id: accountId }))) return fail(404, { error: 'Account not found' });
		const fd = await request.formData();
		const clinicAccountId = String(fd.get('clinicAccountId') ?? '');
		if (!clinicAccountId) return fail(400, { error: 'Choose a clinic' });
		const outcome = await enrollInClinic({ accountId, clinicAccountId, operator: operatorOf(locals) });
		return outcome.ok ? { success: true, message: outcome.message } : fail(400, { error: outcome.error });
	},

	/**
	 * Remove an account from its clinic: this account (no field), or one of
	 * the accounts enrolled under this clinic (`enrolledAccountId`).
	 */
	unenroll: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const accountId = decodeURIComponent(params.accountId);
		const fd = await request.formData();
		const enrolledAccountId = String(fd.get('enrolledAccountId') ?? '');
		if (enrolledAccountId && (await settingsFor(enrolledAccountId)).clinicAccountId !== accountId)
			return fail(404, { error: 'That account is not enrolled under this clinic' });
		const outcome = await removeFromClinic({ accountId: enrolledAccountId || accountId, operator: operatorOf(locals) });
		return outcome.ok ? { success: true, message: outcome.message } : fail(400, { error: outcome.error });
	},

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

	/**
	 * Give this account one or more cartridges: a personal ownership row with
	 * source 'operator' each. `cartridgeIds` holds whatever the scanner typed —
	 * one id per line (or separated by spaces/commas); each is assigned on its
	 * own, so one bad id does not stop the rest.
	 */
	assign: async ({ request, locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const accountId = decodeURIComponent(params.accountId);
		const fd = await request.formData();
		const ids = parseScannedIds(String(fd.get('cartridgeIds') ?? fd.get('cartridgeId') ?? ''));
		if (!ids.length) return fail(400, { error: 'Scan or enter at least one cartridge id' });
		if (ids.length > MAX_BULK_ASSIGN) return fail(400, { error: `At most ${MAX_BULK_ASSIGN} cartridges at a time — you entered ${ids.length}` });
		if (!(await AppUser.exists({ _id: accountId }))) return fail(404, { error: 'Account not found' });
		const replace = fd.get('replace') === 'on';
		const note = String(fd.get('note') ?? '').trim() || null;
		const operator = operatorOf(locals);
		const results: { cartridgeId: string; ok: boolean; text: string }[] = [];
		for (const cartridgeId of ids) {
			if (!CARTRIDGE_ID.test(cartridgeId)) {
				results.push({ cartridgeId, ok: false, text: 'Not a cartridge id' });
				continue;
			}
			const outcome = await assignOwnership({ cartridgeId, accountId, replace, note, operator });
			results.push(outcome.ok
				? { cartridgeId, ok: true, text: outcome.matchedShipment ? 'Assigned' : 'Assigned (no shipment to this account’s customers on record)' }
				: { cartridgeId, ok: false, text: outcome.reasonText });
		}
		const assigned = results.filter((r) => r.ok).length;
		const failed = results.length - assigned;
		const message = `${assigned} of ${results.length} cartridge${results.length === 1 ? '' : 's'} assigned${failed ? ` — ${failed} not assigned, see below` : ''}`;
		return assigned ? { success: true, message, results } : fail(409, { error: message, results });
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
	},

	/**
	 * Open the consumer app as this account (temporary developer door,
	 * src/lib/server/consumer/view-as.ts). The browser follows the redirect
	 * to the app, which verifies the two-minute token and starts the session.
	 */
	viewAs: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		if (!viewAsConfigured()) return fail(503, { error: 'CONSUMER_API_KEY and BIOSCALE_APP_URL must be set before the app can be opened from BIMS' });
		await connectDB();
		const accountId = decodeURIComponent(params.accountId);
		if (!(await AppUser.exists({ _id: accountId }))) return fail(404, { error: 'Account not found' });
		const token = mintViewAsToken({ accountId, actor: operatorOf(locals).username });
		redirect(303, viewAsUrl(token));
	},

	/** Remove a dev account (never a real one — those are blocked, not deleted). */
	deleteDev: async ({ locals, params }) => {
		if (!locals.user) redirect(302, '/login');
		requirePermission(locals.user, 'customer:write');
		await connectDB();
		const outcome = await deleteDevAccount({ accountId: decodeURIComponent(params.accountId), operator: operatorOf(locals) });
		if (!outcome.ok) return fail(400, { error: outcome.error });
		redirect(303, '/app-accounts?removed=1');
	}
};

export const config = { maxDuration: 60 };
