import { createHash, randomBytes } from 'node:crypto';
import {
	AuditLog,
	CartridgeOwnership,
	CartridgeRecord,
	ConsumerClaimAttempt,
	ConsumerInvite,
	Customer,
	CustomerAccount,
	ShippingLot,
	generateId
} from '$lib/server/db';

/**
 * Consumer cartridge ownership — the one place that decides whether a
 * cartridge may be claimed by an app account and writes the ownership rows.
 * Called by the consumer API (src/routes/api/consumer/*), the ship-time hook
 * on the shipping page, and the operator actions on the DHR page.
 * Contract: docs/CONSUMER-OWNERSHIP.md.
 */

export type Actor = { kind: 'account' | 'operator' | 'system'; id: string; label: string };

export type ClaimReason =
	| 'not_found'
	| 'voided'
	| 'qc_cartridge'
	| 'research'
	| 'already_owned'
	| 'guessable_id_needs_match'
	| 'rate_limited';

export type Stage = 'ready' | 'used' | 'expired' | 'unavailable';

/** Sequential ids like CART-000123 are enumerable; UUIDs are not. */
export const GUESSABLE_ID = /^[A-Z]{2,8}-\d{3,}$/;
export const isGuessableId = (id: string) => GUESSABLE_ID.test(id);

/** Claims per account per hour before the API refuses further attempts. */
export const MAX_CLAIM_ATTEMPTS_PER_HOUR = 30;

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
	guessable_id_needs_match: 'This cartridge was not shipped to you. Check the code or contact support.',
	rate_limited: 'Too many attempts. Try again in an hour.'
};

const CARTRIDGE_FIELDS = {
	status: 1, voidedAt: 1, experiment: 1, usedForTestFill: 1, expirationDate: 1,
	assayName: 1, 'reagentFilling.assayType': 1, 'reagentFilling.expirationDate': 1,
	'assayLoaded.assay': 1, 'shipping.customer': 1
} as const;

function assayNameOf(c: any): string | null {
	return c?.assayName ?? c?.reagentFilling?.assayType?.name ?? c?.assayLoaded?.assay?.name ?? null;
}

function expiryOf(c: any): string | null {
	const exp = c?.reagentFilling?.expirationDate ?? c?.expirationDate ?? null;
	if (!exp) return null;
	const d = new Date(exp);
	return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

async function isQcCartridge(cartridgeId: string): Promise<boolean> {
	return Boolean(await ShippingLot.exists({ 'qaqcReleases.qaqcCartridgeIds': cartridgeId }));
}

async function allowsResearch(customerIds: string[]): Promise<boolean> {
	if (!customerIds.length) return false;
	return Boolean(await Customer.exists({ _id: { $in: customerIds }, customerType: 'internal' }));
}

export type LookupContext = { accountId: string; customerIds: string[] };

export type LookupResult = {
	found: boolean;
	cartridgeId: string;
	assayName: string | null;
	expiresAt: string | null;
	stage: Stage | null;
	/** Someone (anyone) holds an open row. Never says who. */
	owned: boolean;
	/** The asking account, or one of its customers, holds the open row. */
	ownedByYou: boolean;
	matchedShipment: boolean;
	/** Customer name is returned only when it is one of the asker's own. */
	shipmentCustomer: { id: string; name: string } | null;
	guessableId: boolean;
	eligible: boolean;
	reason: ClaimReason | null;
	reasonText: string | null;
};

/** The safe preview the app shows before a claim is confirmed. */
export async function lookupCartridge(cartridgeId: string, ctx: LookupContext): Promise<LookupResult> {
	const cartridge = (await CartridgeRecord.findById(cartridgeId, CARTRIDGE_FIELDS).lean()) as any;
	const base: LookupResult = {
		found: Boolean(cartridge), cartridgeId, assayName: null, expiresAt: null, stage: null,
		owned: false, ownedByYou: false, matchedShipment: false, shipmentCustomer: null,
		guessableId: isGuessableId(cartridgeId), eligible: false, reason: 'not_found',
		reasonText: REASON_TEXT.not_found
	};
	if (!cartridge) return base;

	const [open, qc, research] = await Promise.all([
		CartridgeOwnership.findOne({ cartridgeId, open: true }).lean() as Promise<any>,
		isQcCartridge(cartridgeId),
		allowsResearch(ctx.customerIds)
	]);
	const shipCustomerId: string | null = cartridge.shipping?.customer?._id ?? null;
	const matched = Boolean(shipCustomerId && ctx.customerIds.includes(shipCustomerId));
	const ownedByYou = Boolean(open && (
		open.accountId === ctx.accountId || (open.customerId && ctx.customerIds.includes(open.customerId))
	));
	const verdict = claimEligibility({
		cartridge, hasOpenOwnership: Boolean(open), isQcCartridge: qc, matchedShipment: matched, allowResearch: research
	});
	return {
		...base,
		assayName: assayNameOf(cartridge),
		expiresAt: expiryOf(cartridge),
		stage: stageOf(cartridge),
		owned: Boolean(open),
		ownedByYou,
		matchedShipment: matched,
		shipmentCustomer: matched ? { id: shipCustomerId!, name: cartridge.shipping?.customer?.name ?? '' } : null,
		eligible: verdict.ok,
		reason: verdict.ok ? null : verdict.reason,
		reasonText: verdict.ok ? null : REASON_TEXT[verdict.reason]
	};
}

export type ClaimInput = {
	cartridgeId: string;
	accountId: string;
	accountLabel: string;
	/** The account's active customer links — for shipment matching and clinic scoping. */
	customerIds: string[];
	/** For a clinic claim: which customer the cartridge is claimed under. */
	customerId?: string | null;
	/** For a clinic claim: the patient; null leaves it in the customer's unassigned bin. */
	subjectId?: string | null;
};

export type ClaimOutcome =
	| { ok: true; row: Record<string, unknown> }
	| { ok: false; reason: ClaimReason; reasonText: string };

async function recordAttempt(accountId: string, cartridgeId: string, outcome: string) {
	await ConsumerClaimAttempt.create({ _id: generateId(), accountId, cartridgeId, outcome, at: new Date() });
}

export async function claimCartridge(input: ClaimInput): Promise<ClaimOutcome> {
	const { cartridgeId, accountId } = input;
	const since = new Date(Date.now() - 60 * 60 * 1000);
	const attempts = await ConsumerClaimAttempt.countDocuments({ accountId, at: { $gte: since } });
	if (attempts >= MAX_CLAIM_ATTEMPTS_PER_HOUR) {
		await recordAttempt(accountId, cartridgeId, 'rate_limited');
		return { ok: false, reason: 'rate_limited', reasonText: REASON_TEXT.rate_limited };
	}
	if (input.customerId && !input.customerIds.includes(input.customerId)) {
		// A clinic claim must be under one of the claimer's own customers.
		await recordAttempt(accountId, cartridgeId, 'guessable_id_needs_match');
		return { ok: false, reason: 'guessable_id_needs_match', reasonText: REASON_TEXT.guessable_id_needs_match };
	}

	const look = await lookupCartridge(cartridgeId, { accountId, customerIds: input.customerIds });
	if (!look.eligible) {
		const reason = look.reason ?? 'not_found';
		await recordAttempt(accountId, cartridgeId, reason);
		return { ok: false, reason, reasonText: REASON_TEXT[reason] };
	}

	const now = new Date();
	const cartridge = (await CartridgeRecord.findById(cartridgeId, { 'shipping.customer': 1 }).lean()) as any;
	const clinic = Boolean(input.customerId);
	const row = {
		_id: generateId(),
		cartridgeId,
		// A clinic claim is owned by the customer (and optionally a patient); a
		// personal claim is owned by the account itself.
		accountId: clinic ? null : accountId,
		customerId: input.customerId ?? null,
		subjectId: input.subjectId ?? null,
		source: 'claim' as const,
		matchedShipment: look.matchedShipment,
		shipmentCustomerId: cartridge?.shipping?.customer?._id ?? null,
		open: true,
		claimedAt: now,
		claimedBy: { kind: 'account' as const, id: accountId, label: input.accountLabel }
	};
	try {
		await CartridgeOwnership.create(row);
	} catch (e: any) {
		// Partial unique index: someone claimed it between lookup and insert.
		if (e?.code === 11000) {
			await recordAttempt(accountId, cartridgeId, 'already_owned');
			return { ok: false, reason: 'already_owned', reasonText: REASON_TEXT.already_owned };
		}
		throw e;
	}
	await Promise.all([
		recordAttempt(accountId, cartridgeId, 'claimed'),
		AuditLog.create({
			_id: generateId(),
			tableName: 'cartridge_ownership', recordId: row._id, action: 'CLAIM',
			changedBy: `app:${accountId}`, changedAt: now,
			newData: { cartridgeId, accountId: row.accountId, customerId: row.customerId, subjectId: row.subjectId, matchedShipment: row.matchedShipment }
		})
	]);
	return { ok: true, row: JSON.parse(JSON.stringify(row)) };
}

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
