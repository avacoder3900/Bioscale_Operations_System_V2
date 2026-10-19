import { createHash, randomBytes } from 'node:crypto';
import {
	AuditLog,
	CartridgeOwnership,
	CartridgeRecord,
	ConsumerInvite,
	Customer,
	CustomerAccount,
	ShippingLot,
	generateId
} from '$lib/server/db';

/**
 * Consumer cartridge ownership — the one place that writes the ownership rows.
 * Cartridges are assigned to app accounts in BIMS: by operators (App Accounts
 * and DHR pages, assignOwnership) or by the ship-time hook on the shipping page
 * (ownershipForShipment). The consumer API (src/routes/api/consumer/*) only
 * moves a clinic cartridge between patients, releases, handles invites, and —
 * since 2026-10-19 — lets a person scan a cartridge to link it to themselves
 * as the first step of a test (claimForAccount, optionally overwriting
 * another account's link).
 * Contract: docs/CONSUMER-OWNERSHIP.md.
 */

export type Actor = { kind: 'account' | 'operator' | 'system'; id: string; label: string };

export type ClaimReason =
	| 'not_found'
	| 'voided'
	| 'qc_cartridge'
	| 'research'
	| 'already_owned'
	| 'guessable_id_needs_match';

export type Stage = 'ready' | 'used' | 'expired' | 'unavailable';

/** Sequential ids like CART-000123 are enumerable; UUIDs are not. */
export const GUESSABLE_ID = /^[A-Z]{2,8}-\d{3,}$/;
export const isGuessableId = (id: string) => GUESSABLE_ID.test(id);

const UNAVAILABLE_STATUSES = new Set(['voided', 'scrapped', 'cancelled']);
const IN_USE_STATUSES = new Set(['linked', 'underway', 'completed']);

type CartridgeLike = {
	_id: string;
	status?: string | null;
	voidedAt?: Date | string | null;
	experiment?: string | null;
	usedForTestFill?: boolean | null;
	expirationDate?: string | null;
	reagentFilling?: { expirationDate?: Date | string | null } | null;
	assayName?: string | null;
	reagentFilling_assayName?: string | null;
	shipping?: { customer?: { _id?: string | null; name?: string | null } | null } | null;
};

/** What a person can do with the cartridge, in app terms. Pure. */
export function stageOf(c: CartridgeLike, now = new Date()): Stage {
	if (c.voidedAt || (c.status && UNAVAILABLE_STATUSES.has(c.status))) return 'unavailable';
	if (c.status && IN_USE_STATUSES.has(c.status)) return 'used';
	const exp = c.reagentFilling?.expirationDate ?? c.expirationDate ?? null;
	if (exp) {
		const t = new Date(exp).getTime();
		if (!Number.isNaN(t) && t < now.getTime()) return 'expired';
	}
	return 'ready';
}

export type EligibilityInput = {
	cartridge: CartridgeLike | null;
	hasOpenOwnership: boolean;
	isQcCartridge: boolean;
	matchedShipment: boolean;
	allowResearch: boolean;
};

/**
 * Whether a claim may proceed. Pure, so the rules are unit-testable and the
 * same function answers the preview (lookup) and the claim itself.
 *
 * Shipment matching is deliberately NOT a gate (decision 2026-10-15: an
 * account may claim a cartridge that was never shipped to it); it is recorded
 * on the row for review. The one exception is a guessable sequential id,
 * which could be enumerated — those need the shipment to match.
 */
export function claimEligibility(input: EligibilityInput): { ok: true } | { ok: false; reason: ClaimReason } {
	const { cartridge } = input;
	if (!cartridge) return { ok: false, reason: 'not_found' };
	if (stageOf(cartridge) === 'unavailable') return { ok: false, reason: 'voided' };
	if (input.isQcCartridge || cartridge.usedForTestFill) return { ok: false, reason: 'qc_cartridge' };
	if (cartridge.experiment && !input.allowResearch) return { ok: false, reason: 'research' };
	if (input.hasOpenOwnership) return { ok: false, reason: 'already_owned' };
	if (isGuessableId(cartridge._id) && !input.matchedShipment) {
		return { ok: false, reason: 'guessable_id_needs_match' };
	}
	return { ok: true };
}

export const REASON_TEXT: Record<ClaimReason, string> = {
	not_found: 'No cartridge with this code exists.',
	voided: 'This cartridge was voided or scrapped and cannot be used.',
	qc_cartridge: 'This is a quality-control cartridge, not a test cartridge.',
	research: 'This cartridge belongs to a research experiment.',
	already_owned: 'This cartridge is already linked to an account.',
	guessable_id_needs_match: 'This cartridge was not shipped to you. Check the code or contact support.'
};

export type ReleaseInput = {
	cartridgeId: string;
	actor: Actor;
	reason: 'user' | 'operator' | 'reassigned' | 'transfer';
	note?: string | null;
	/** When the actor is an account: it may only release rows it can see. */
	scope?: { accountId: string; customerIds: string[] } | null;
};

export async function releaseOwnership(input: ReleaseInput): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'forbidden' }> {
	const open = (await CartridgeOwnership.findOne({ cartridgeId: input.cartridgeId, open: true }).lean()) as any;
	if (!open) return { ok: false, reason: 'not_found' };
	if (input.scope) {
		const mine = open.accountId === input.scope.accountId
			|| (open.customerId && input.scope.customerIds.includes(open.customerId));
		if (!mine) return { ok: false, reason: 'forbidden' };
	}
	const now = new Date();
	await CartridgeOwnership.updateOne({ _id: open._id, open: true }, {
		$set: { open: false, releasedAt: now, releasedBy: input.actor, releaseReason: input.reason, releaseNote: input.note ?? null }
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_ownership', recordId: open._id, action: 'RELEASE',
		changedBy: input.actor.kind === 'account' ? `app:${input.actor.id}` : input.actor.label, changedAt: now,
		oldData: { accountId: open.accountId, customerId: open.customerId, subjectId: open.subjectId },
		newData: { releaseReason: input.reason, note: input.note ?? null }
	});
	return { ok: true };
}

export type AssignInput = {
	cartridgeId: string;
	customerId: string;
	subjectId: string | null;
	actor: Actor;
	customerIds: string[];
};

/** Move a clinic-owned cartridge between patients (or back to unassigned). */
export async function assignSubject(input: AssignInput): Promise<{ ok: true } | { ok: false; reason: 'not_found' | 'forbidden' }> {
	if (!input.customerIds.includes(input.customerId)) return { ok: false, reason: 'forbidden' };
	const open = (await CartridgeOwnership.findOne({ cartridgeId: input.cartridgeId, open: true }).lean()) as any;
	if (!open) return { ok: false, reason: 'not_found' };
	if (open.customerId !== input.customerId) return { ok: false, reason: 'forbidden' };
	const now = new Date();
	await CartridgeOwnership.updateOne({ _id: open._id }, { $set: { subjectId: input.subjectId } });
	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_ownership', recordId: open._id, action: 'ASSIGN',
		changedBy: `app:${input.actor.id}`, changedAt: now,
		oldData: { subjectId: open.subjectId }, newData: { subjectId: input.subjectId }
	});
	return { ok: true };
}

async function isQcCartridge(cartridgeId: string): Promise<boolean> {
	return Boolean(await ShippingLot.exists({ 'qaqcReleases.qaqcCartridgeIds': cartridgeId }));
}

export type AssignReason = 'not_found' | 'voided' | 'qc_cartridge' | 'already_owned' | 'no_target';

export const ASSIGN_REASON_TEXT: Record<AssignReason, string> = {
	not_found: 'No cartridge with that id exists.',
	voided: 'That cartridge was voided or scrapped and cannot be assigned.',
	qc_cartridge: 'That is a quality-control cartridge, not a test cartridge.',
	already_owned: 'That cartridge already belongs to an account. Tick "replace" to reassign it.',
	no_target: 'Pick an account or a customer to assign the cartridge to.'
};

export type AssignOwnershipInput = {
	cartridgeId: string;
	/** Personal row: the app account that will see the cartridge. */
	accountId?: string | null;
	/** Clinic row: the customer whose unassigned bin receives it, optionally with a patient. */
	customerId?: string | null;
	subjectId?: string | null;
	/** Close an existing open row first (releaseReason 'reassigned'). */
	replace?: boolean;
	note?: string | null;
	operator: OperatorRef;
};

export type AssignOwnershipOutcome =
	| { ok: true; rowId: string; matchedShipment: boolean }
	| { ok: false; reason: AssignReason; reasonText: string };

/**
 * Operator assignment (BIMS App Accounts and DHR pages) — how a cartridge gets
 * an owner now that people do not scan them in. Refuses cartridges that are
 * voided or QC; research cartridges are allowed (the operator knows the
 * experiment, and internal testers are the usual target). The shipment match
 * is recorded for the ownership report, never enforced.
 */
export async function assignOwnership(input: AssignOwnershipInput): Promise<AssignOwnershipOutcome> {
	const accountId = input.accountId?.trim() || null;
	const customerId = input.customerId?.trim() || null;
	if (!accountId && !customerId) return { ok: false, reason: 'no_target', reasonText: ASSIGN_REASON_TEXT.no_target };

	const cartridge = (await CartridgeRecord.findById(input.cartridgeId, {
		status: 1, voidedAt: 1, usedForTestFill: 1, 'shipping.customer': 1
	}).lean()) as any;
	if (!cartridge) return { ok: false, reason: 'not_found', reasonText: ASSIGN_REASON_TEXT.not_found };
	if (stageOf(cartridge) === 'unavailable') return { ok: false, reason: 'voided', reasonText: ASSIGN_REASON_TEXT.voided };
	if (cartridge.usedForTestFill || (await isQcCartridge(input.cartridgeId))) {
		return { ok: false, reason: 'qc_cartridge', reasonText: ASSIGN_REASON_TEXT.qc_cartridge };
	}

	const actor: Actor = { kind: 'operator', id: input.operator._id, label: input.operator.username };
	const open = (await CartridgeOwnership.findOne({ cartridgeId: input.cartridgeId, open: true }).select('_id').lean()) as any;
	if (open) {
		if (!input.replace) return { ok: false, reason: 'already_owned', reasonText: ASSIGN_REASON_TEXT.already_owned };
		await releaseOwnership({
			cartridgeId: input.cartridgeId, actor, reason: 'reassigned',
			note: input.note || 'Reassigned by operator'
		});
	}

	const shipCustomerId: string | null = cartridge.shipping?.customer?._id ?? null;
	const matchedShipment = Boolean(shipCustomerId && (
		customerId ? shipCustomerId === customerId : (await customerIdsFor(accountId!)).includes(shipCustomerId)
	));
	const now = new Date();
	const row = {
		_id: generateId(),
		cartridgeId: input.cartridgeId,
		accountId: customerId ? null : accountId,
		customerId,
		subjectId: customerId ? (input.subjectId?.trim() || null) : null,
		source: 'operator' as const,
		matchedShipment,
		shipmentCustomerId: shipCustomerId,
		open: true,
		claimedAt: now,
		claimedBy: actor
	};
	try {
		await CartridgeOwnership.create(row);
	} catch (e: any) {
		// Partial unique index: another operator assigned it between the check and the insert.
		if (e?.code === 11000) return { ok: false, reason: 'already_owned', reasonText: ASSIGN_REASON_TEXT.already_owned };
		throw e;
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_ownership', recordId: row._id, action: 'ASSIGN_OWNERSHIP',
		changedBy: input.operator.username, changedAt: now,
		newData: { cartridgeId: row.cartridgeId, accountId: row.accountId, customerId: row.customerId, subjectId: row.subjectId, matchedShipment, replaced: Boolean(open), note: input.note ?? null }
	});
	return { ok: true, rowId: row._id, matchedShipment };
}

/**
 * Ship-time hook. For every cartridge just added to a package: a customer
 * with exactly one active account gets a personal row for that account; a
 * customer with several (a clinic) gets a customer-scoped row with no account
 * or patient yet — the app's "unassigned" bin; a customer with none gets no
 * row (the person will claim it later). Cartridges that already have an open
 * row are left alone.
 */
export async function ownershipForShipment(
	cartridgeIds: string[],
	customer: { _id: string; name?: string | null },
	actor: Actor
): Promise<number> {
	if (!cartridgeIds.length) return 0;
	const accounts = (await CustomerAccount.find({ customerId: customer._id, status: 'active' })
		.select('accountId role').lean()) as any[];
	if (!accounts.length) return 0;
	const sole = accounts.length === 1 ? accounts[0].accountId as string : null;
	const already = new Set(
		((await CartridgeOwnership.find({ cartridgeId: { $in: cartridgeIds }, open: true }).select('cartridgeId').lean()) as any[])
			.map((r) => r.cartridgeId as string)
	);
	const now = new Date();
	const rows = cartridgeIds.filter((id) => !already.has(id)).map((cartridgeId) => ({
		_id: generateId(),
		cartridgeId,
		accountId: sole,
		customerId: customer._id,
		subjectId: null,
		source: 'shipment' as const,
		matchedShipment: true,
		shipmentCustomerId: customer._id,
		open: true,
		claimedAt: now,
		claimedBy: actor
	}));
	if (!rows.length) return 0;
	await CartridgeOwnership.insertMany(rows, { ordered: false });
	await AuditLog.insertMany(rows.map((r) => ({
		_id: generateId(),
		tableName: 'cartridge_ownership', recordId: r._id, action: 'SHIPMENT_OWNERSHIP',
		changedBy: actor.label, changedAt: now,
		newData: { cartridgeId: r.cartridgeId, accountId: r.accountId, customerId: r.customerId }
	})));
	return rows.length;
}

// ---------------------------------------------------------------------------
// App scan-in (2026-10-19): "start a new test" opens with a scan of the cartridge

/** A cartridge that has run on a device: its results belong to whoever owns it. */
const RUN_STATUSES = new Set(['underway', 'completed']);

async function allowsResearch(customerIds: string[]): Promise<boolean> {
	if (!customerIds.length) return false;
	return Boolean(await Customer.exists({ _id: { $in: customerIds }, customerType: 'internal' }));
}

export type AppClaimReason = Exclude<ClaimReason, 'already_owned'> | 'owned_by_other' | 'has_results';

export const APP_CLAIM_TEXT: Record<AppClaimReason, string> = {
	not_found: REASON_TEXT.not_found,
	voided: REASON_TEXT.voided,
	qc_cartridge: REASON_TEXT.qc_cartridge,
	research: REASON_TEXT.research,
	guessable_id_needs_match: REASON_TEXT.guessable_id_needs_match,
	owned_by_other: 'This cartridge is already linked to someone else.',
	has_results: 'This cartridge has already been used by someone else, so it cannot be moved to your account.'
};

export type AppClaimInput = {
	cartridgeId: string;
	accountId: string;
	accountLabel: string;
	/** The account's active customer links — for shipment matching and research access. */
	customerIds: string[];
	/** The person said yes to "link it to your own account?": close the other account's row first. */
	overwrite: boolean;
};

export type AppClaimOutcome =
	| { ok: true; status: 'linked' | 'already_yours' | 'overwritten'; rowId: string }
	| { ok: false; reason: AppClaimReason; reasonText: string };

/**
 * Link a scanned cartridge to the scanning account (personal row, source
 * 'claim'). Same eligibility as the pre-2026-10-16 claim (claimEligibility),
 * with one change the app asked for: a cartridge linked to another account is
 * refused with `owned_by_other` unless `overwrite` is set, in which case the
 * other row is closed (releaseReason 'reassigned') and a new one opened.
 * Overwrite never moves a cartridge that has already run — that would hand
 * the other person's result to the scanner — and guessable sequential ids
 * still need a shipment match.
 */
export async function claimForAccount(input: AppClaimInput): Promise<AppClaimOutcome> {
	const { cartridgeId, accountId } = input;
	const refuse = (reason: AppClaimReason): AppClaimOutcome => ({ ok: false, reason, reasonText: APP_CLAIM_TEXT[reason] });

	const [cartridge, open, qc, research] = await Promise.all([
		CartridgeRecord.findById(cartridgeId, {
			status: 1, voidedAt: 1, usedForTestFill: 1, experiment: 1, 'shipping.customer': 1
		}).lean() as Promise<any>,
		CartridgeOwnership.findOne({ cartridgeId, open: true }).lean() as Promise<any>,
		isQcCartridge(cartridgeId),
		allowsResearch(input.customerIds)
	]);
	if (open && open.accountId === accountId) return { ok: true, status: 'already_yours', rowId: open._id };

	const shipCustomerId: string | null = cartridge?.shipping?.customer?._id ?? null;
	const matchedShipment = Boolean(shipCustomerId && input.customerIds.includes(shipCustomerId));
	const verdict = claimEligibility({
		cartridge, hasOpenOwnership: false, isQcCartridge: qc, matchedShipment, allowResearch: research
	});
	if (!verdict.ok) return refuse(verdict.reason as AppClaimReason);

	const actor: Actor = { kind: 'account', id: accountId, label: input.accountLabel };
	if (open) {
		if (!input.overwrite) return refuse('owned_by_other');
		if (cartridge.status && RUN_STATUSES.has(cartridge.status)) return refuse('has_results');
		await releaseOwnership({ cartridgeId, actor, reason: 'reassigned', note: 'Overwritten by an app scan' });
	}

	const now = new Date();
	const row = {
		_id: generateId(),
		cartridgeId,
		accountId,
		customerId: null,
		subjectId: null,
		source: 'claim' as const,
		matchedShipment,
		shipmentCustomerId: shipCustomerId,
		open: true,
		claimedAt: now,
		claimedBy: actor
	};
	try {
		await CartridgeOwnership.create(row);
	} catch (e: any) {
		// Partial unique index: someone else linked it between the check and the insert.
		if (e?.code === 11000) return refuse('owned_by_other');
		throw e;
	}
	await AuditLog.create({
		_id: generateId(),
		tableName: 'cartridge_ownership', recordId: row._id, action: 'CLAIM',
		changedBy: `app:${accountId}`, changedAt: now,
		oldData: open ? { accountId: open.accountId, customerId: open.customerId, subjectId: open.subjectId } : undefined,
		newData: { cartridgeId, accountId, matchedShipment, overwritten: Boolean(open) }
	});
	return { ok: true, status: open ? 'overwritten' : 'linked', rowId: row._id };
}

// ---------------------------------------------------------------------------
// Invites: a customer's app access

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export const normalizeEmail = (e: string) => e.trim().toLowerCase();

export async function createInvite(input: {
	customerId: string; email: string; role: 'admin' | 'staff' | 'member'; actor: Actor;
}): Promise<{ inviteId: string; token: string; expiresAt: Date }> {
	const token = randomBytes(32).toString('base64url');
	const now = new Date();
	const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
	const _id = generateId();
	await ConsumerInvite.create({
		_id, customerId: input.customerId, email: normalizeEmail(input.email), role: input.role,
		tokenHash: hashToken(token), status: 'pending', createdBy: input.actor, expiresAt
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'consumer_invites', recordId: _id, action: 'INSERT',
		changedBy: input.actor.label, changedAt: now,
		newData: { customerId: input.customerId, email: normalizeEmail(input.email), role: input.role }
	});
	return { inviteId: _id, token, expiresAt };
}

export type AcceptOutcome =
	| { ok: true; customerId: string; customerName: string; role: 'admin' | 'staff' | 'member' }
	| { ok: false; reason: 'invalid' | 'expired' | 'email_mismatch' };

/**
 * Accept an invite for an account. The token must be pending and unexpired,
 * and the account's sign-in email must match the invited address — so a link
 * that reaches the wrong inbox links nobody.
 */
export async function acceptInvite(input: { token: string; accountId: string; email: string }): Promise<AcceptOutcome> {
	const invite = (await ConsumerInvite.findOne({ tokenHash: hashToken(input.token) }).lean()) as any;
	if (!invite || invite.status !== 'pending') return { ok: false, reason: 'invalid' };
	if (invite.expiresAt.getTime() < Date.now()) {
		await ConsumerInvite.updateOne({ _id: invite._id }, { $set: { status: 'expired' } });
		return { ok: false, reason: 'expired' };
	}
	if (invite.email !== normalizeEmail(input.email)) return { ok: false, reason: 'email_mismatch' };

	const now = new Date();
	const customer = (await Customer.findById(invite.customerId).select('name').lean()) as any;
	await CustomerAccount.updateOne(
		{ customerId: invite.customerId, accountId: input.accountId },
		{
			$set: {
				email: normalizeEmail(input.email), role: invite.role, status: 'active', inviteId: invite._id,
				linkedBy: { kind: 'account', id: input.accountId, label: normalizeEmail(input.email) }, linkedAt: now,
				revokedAt: null, revokedBy: null
			},
			$setOnInsert: { _id: generateId() }
		},
		{ upsert: true }
	);
	await ConsumerInvite.updateOne({ _id: invite._id }, { $set: { status: 'accepted', acceptedAt: now, acceptedAccountId: input.accountId } });
	await AuditLog.create({
		_id: generateId(),
		tableName: 'customer_accounts', recordId: `${invite.customerId}:${input.accountId}`, action: 'LINK',
		changedBy: `app:${input.accountId}`, changedAt: now,
		newData: { customerId: invite.customerId, accountId: input.accountId, role: invite.role, inviteId: invite._id }
	});
	return { ok: true, customerId: invite.customerId, customerName: customer?.name ?? '', role: invite.role };
}

/** Active customer links for an account — the scope every consumer call runs under. */
export async function customerIdsFor(accountId: string): Promise<string[]> {
	const rows = (await CustomerAccount.find({ accountId, status: 'active' }).select('customerId').lean()) as any[];
	return rows.map((r) => r.customerId as string);
}

export async function isCustomerAdmin(accountId: string, customerId: string): Promise<boolean> {
	return Boolean(await CustomerAccount.exists({ accountId, customerId, status: 'active', role: 'admin' }));
}

// ---------------------------------------------------------------------------
// Account management (BIMS /app-accounts): link, revoke, block

export type OperatorRef = { _id: string; username: string };

/** Link an app account to a customer with a role (upsert; reactivates a revoked link). */
export async function linkAccountToCustomer(input: {
	accountId: string; customerId: string; role: 'admin' | 'staff' | 'member'; email: string | null; operator: OperatorRef;
}): Promise<void> {
	const now = new Date();
	const actor: Actor = { kind: 'operator', id: input.operator._id, label: input.operator.username };
	await CustomerAccount.updateOne(
		{ customerId: input.customerId, accountId: input.accountId },
		{
			$set: { role: input.role, status: 'active', email: input.email, linkedBy: actor, linkedAt: now, revokedAt: null, revokedBy: null },
			$setOnInsert: { _id: generateId() }
		},
		{ upsert: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'customer_accounts', recordId: `${input.customerId}:${input.accountId}`, action: 'LINK',
		changedBy: input.operator.username, changedAt: now,
		newData: { customerId: input.customerId, accountId: input.accountId, role: input.role }
	});
}

export async function revokeCustomerLink(input: { linkId: string; operator: OperatorRef }): Promise<boolean> {
	const now = new Date();
	const actor: Actor = { kind: 'operator', id: input.operator._id, label: input.operator.username };
	const res = await CustomerAccount.updateOne(
		{ _id: input.linkId, status: 'active' },
		{ $set: { status: 'revoked', revokedAt: now, revokedBy: actor } }
	);
	if (!res.matchedCount) return false;
	await AuditLog.create({
		_id: generateId(),
		tableName: 'customer_accounts', recordId: input.linkId, action: 'REVOKE',
		changedBy: input.operator.username, changedAt: now
	});
	return true;
}
