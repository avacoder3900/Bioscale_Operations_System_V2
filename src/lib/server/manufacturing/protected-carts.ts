import { AppUser, CartridgeOwnership, CartridgeRecord, Customer } from '$lib/server/db';

/**
 * Protected carts — carts a bulk status tool must not move silently.
 *
 * A cart is protected when any of these hold:
 *  - it is linked into a research experiment (`experiment` set by the research app);
 *  - its status is test-side (linked / underway / completed) — brevitest-cloud
 *    owns it from there and the device only runs carts at linked/underway;
 *  - an app account (or a clinic customer) has an open ownership row on it.
 *
 * Used by the State Change page (2026-10-21) after five carts linked to
 * experiment 374 and assigned to an app account were bulk-moved to
 * reagent_filled on 2026-10-20 and the device then refused to run them.
 * Pure lookup: nothing here writes.
 */

export const TEST_SIDE_STATUSES = ['linked', 'underway', 'completed'] as const;

export type ProtectedCart = {
	barcode: string;
	status: string;
	/** Research experiment + arm the cart is linked into, if any. */
	experiment: string | null;
	arm: string | null;
	/** Open ownership, if any — account name/email or customer name resolved for display. */
	owner: {
		accountId: string | null;
		accountLabel: string | null;
		customerId: string | null;
		customerName: string | null;
	} | null;
	/** Human-readable reasons, one per rule that fired. */
	reasons: string[];
};

/** Which of the given barcodes are protected, and why, in the order given. Unknown barcodes are skipped. */
export async function findProtectedCarts(barcodes: string[]): Promise<ProtectedCart[]> {
	if (!barcodes.length) return [];
	const [carts, owners] = await Promise.all([
		CartridgeRecord.find({ _id: { $in: barcodes } }).select('_id status experiment arm').lean() as Promise<any[]>,
		CartridgeOwnership.find({ cartridgeId: { $in: barcodes }, open: true })
			.select('cartridgeId accountId customerId').lean() as Promise<any[]>
	]);
	const ownerByCart = new Map(owners.map((o) => [o.cartridgeId as string, o]));
	const accountIds = Array.from(new Set(owners.map((o) => o.accountId).filter(Boolean))) as string[];
	const customerIds = Array.from(new Set(owners.map((o) => o.customerId).filter(Boolean))) as string[];
	const [users, customers] = await Promise.all([
		accountIds.length ? (AppUser.find({ _id: { $in: accountIds } }).select('name signInEmail').lean() as Promise<any[]>) : [],
		customerIds.length ? (Customer.find({ _id: { $in: customerIds } }).select('name').lean() as Promise<any[]>) : []
	]);
	const userLabel = new Map(users.map((u) => [u._id as string, (u.name || u.signInEmail || null) as string | null]));
	const customerName = new Map(customers.map((c) => [c._id as string, (c.name ?? null) as string | null]));

	const out: ProtectedCart[] = [];
	for (const cart of carts) {
		const status = (cart.status as string | undefined) ?? 'none';
		const experiment = (cart.experiment as string | undefined) || null;
		const arm = (cart.arm as string | undefined) || null;
		const own = ownerByCart.get(cart._id as string);
		const reasons: string[] = [];
		if (experiment) reasons.push(`linked to experiment "${experiment}"${arm ? ` (arm "${arm}")` : ''}`);
		if ((TEST_SIDE_STATUSES as readonly string[]).includes(status)) reasons.push(`status is ${status} — the device side owns it now`);
		if (own) {
			const who = own.accountId
				? `app account ${userLabel.get(own.accountId) ?? own.accountId}`
				: `customer ${customerName.get(own.customerId) ?? own.customerId} (not yet assigned to a patient)`;
			reasons.push(`owned by ${who}`);
		}
		if (!reasons.length) continue;
		out.push({
			barcode: cart._id as string,
			status,
			experiment,
			arm,
			owner: own ? {
				accountId: own.accountId ?? null,
				accountLabel: own.accountId ? (userLabel.get(own.accountId) ?? null) : null,
				customerId: own.customerId ?? null,
				customerName: own.customerId ? (customerName.get(own.customerId) ?? null) : null
			} : null,
			reasons
		});
	}
	const pos = new Map(barcodes.map((b, i) => [b, i]));
	return out.sort((a, b) => (pos.get(a.barcode) ?? 0) - (pos.get(b.barcode) ?? 0));
}

/** Compact form for an audit row / note: what the operator overrode. */
export function protectedSummary(p: ProtectedCart): Record<string, unknown> {
	return {
		status: p.status,
		experiment: p.experiment,
		arm: p.arm,
		accountId: p.owner?.accountId ?? null,
		customerId: p.owner?.customerId ?? null
	};
}
