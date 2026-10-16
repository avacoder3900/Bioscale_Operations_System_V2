import { requirePermission } from '$lib/server/permissions';
import { connectDB, CartridgeOwnership, Customer, AppUser, CartridgeRecord } from '$lib/server/db';
import type { PageServerLoad } from './$types';

/**
 * Consumer ownership report (docs/CONSUMER-OWNERSHIP.md): every open ownership
 * row — assigned by staff (App Accounts / DHR), by the ship-time hook, or by
 * legacy app claims from before scan-in was removed (2026-10-16). The
 * "unmatched" filter is the review queue for those legacy claims whose
 * cartridge was never shipped to the claiming account's customer.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
	requirePermission(locals.user, 'cartridgeAdmin:read');
	await connectDB();

	const filter = url.searchParams.get('filter') ?? 'all';
	const page = Math.max(1, Number(url.searchParams.get('page') ?? '1') || 1);
	const limit = 50;

	const query: Record<string, unknown> = { open: true };
	if (filter === 'unmatched') { query.matchedShipment = false; query.source = 'claim'; }
	else if (filter === 'claims') query.source = 'claim';
	else if (filter === 'shipment') query.source = 'shipment';
	else if (filter === 'operator') query.source = 'operator';

	const [rows, total, counts] = await Promise.all([
		CartridgeOwnership.find(query).sort({ claimedAt: -1 }).skip((page - 1) * limit).limit(limit).lean() as Promise<any[]>,
		CartridgeOwnership.countDocuments(query),
		Promise.all([
			CartridgeOwnership.countDocuments({ open: true }),
			CartridgeOwnership.countDocuments({ open: true, source: 'claim', matchedShipment: false })
		])
	]);

	const customerIds = [...new Set(rows.flatMap((r) => [r.customerId, r.shipmentCustomerId]).filter(Boolean))];
	const accountIds = [...new Set(rows.map((r) => r.accountId ?? r.claimedBy?.id).filter(Boolean))];
	const cartridgeIds = rows.map((r) => r.cartridgeId);
	const [customers, accounts, cartridges] = await Promise.all([
		customerIds.length ? Customer.find({ _id: { $in: customerIds } }).select('name').lean() as Promise<any[]> : [],
		accountIds.length ? AppUser.find({ _id: { $in: accountIds } }).select('signInEmail name').lean() as Promise<any[]> : [],
		cartridgeIds.length
			? CartridgeRecord.find({ _id: { $in: cartridgeIds } }).select('status assayName reagentFilling.assayType.name').lean() as Promise<any[]>
			: []
	]);
	const customerName = (id: string | null) => (id ? customers.find((c) => c._id === id)?.name ?? id : null);
	const account = (id: string | null) => (id ? accounts.find((a) => a._id === id) ?? null : null);

	return {
		filter,
		page,
		limit,
		total,
		openTotal: counts[0],
		unmatchedTotal: counts[1],
		rows: rows.map((r) => {
			const cart = cartridges.find((c) => c._id === r.cartridgeId);
			const acct = account(r.accountId ?? r.claimedBy?.id ?? null);
			return {
				id: r._id,
				cartridgeId: r.cartridgeId,
				cartridgeStatus: cart?.status ?? null,
				assayName: cart?.assayName ?? cart?.reagentFilling?.assayType?.name ?? null,
				source: r.source,
				matchedShipment: Boolean(r.matchedShipment),
				accountEmail: acct?.signInEmail ?? r.claimedBy?.label ?? null,
				accountName: acct?.name ?? null,
				customerName: customerName(r.customerId ?? null),
				shipmentCustomerName: customerName(r.shipmentCustomerId ?? null),
				subjectId: r.subjectId ?? null,
				claimedAt: r.claimedAt ? new Date(r.claimedAt).toISOString() : null
			};
		})
	};
};
