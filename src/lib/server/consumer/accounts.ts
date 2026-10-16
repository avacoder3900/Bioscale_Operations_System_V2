import { AppAccountBlock, AppUser, AuditLog, CartridgeOwnership, CustomerAccount, generateId } from '$lib/server/db';
import type { OperatorRef } from './ownership';

/**
 * Blocking a consumer-app account (BIMS /app-accounts). The app refuses a
 * session whose account is in `app_account_blocks`; nothing is deleted.
 */
export async function blockAccount(input: { accountId: string; reason: string; operator: OperatorRef }): Promise<void> {
	const now = new Date();
	await AppAccountBlock.updateOne(
		{ _id: input.accountId },
		{ $set: { reason: input.reason, blockedBy: input.operator, blockedAt: now } },
		{ upsert: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_account_blocks', recordId: input.accountId, action: 'BLOCK',
		changedBy: input.operator.username, changedAt: now, reason: input.reason
	});
}

export async function unblockAccount(input: { accountId: string; operator: OperatorRef }): Promise<boolean> {
	const res = await AppAccountBlock.deleteOne({ _id: input.accountId });
	if (!res.deletedCount) return false;
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_account_blocks', recordId: input.accountId, action: 'UNBLOCK',
		changedBy: input.operator.username, changedAt: new Date()
	});
	return true;
}

// ---------------------------------------------------------------------------
// Dev accounts (temporary, 2026-10-16): an app account that exists only so
// staff can see the app from a user's point of view. Created and removed
// from BIMS /app-accounts; opened through the "view as" door (view-as.ts),
// which gives a dev account a normal, writable session because no real
// person's data is behind it. This is the ONE place BIMS writes `app_users`
// (docs/CONSUMER-OWNERSHIP.md); the app's ensureProfile() keeps the extra
// `devAccount` field because it spreads the existing document.

export const DEV_ACCOUNT_PROVIDER = 'dev';
export const DEV_ACCOUNT_EMAIL_DOMAIN = 'dev.bioscale.app';
export const isDevAccountId = (id: string) => id.startsWith(`${DEV_ACCOUNT_PROVIDER}:`);

const DEV_SLUG = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;

export async function createDevAccount(input: {
	slug: string; name: string; operator: OperatorRef;
}): Promise<{ ok: true; accountId: string } | { ok: false; error: string }> {
	const slug = input.slug.trim().toLowerCase();
	if (!DEV_SLUG.test(slug)) return { ok: false, error: 'Use 3–40 lowercase letters, digits or dashes for the id' };
	const name = input.name.trim().slice(0, 80) || `Dev ${slug}`;
	const accountId = `${DEV_ACCOUNT_PROVIDER}:${slug}`;
	if (await AppUser.exists({ _id: accountId })) return { ok: false, error: `An account ${accountId} already exists` };
	const now = new Date();
	await AppUser.create({
		_id: accountId,
		provider: DEV_ACCOUNT_PROVIDER,
		sub: slug,
		signInEmail: `${slug}@${DEV_ACCOUNT_EMAIL_DOMAIN}`,
		name,
		nameSource: 'provider',
		bioscaleEmail: null,
		bioscaleEmailVerifiedAt: null,
		pending: null,
		createdAt: now,
		updatedAt: now,
		lastSignInAt: now,
		devAccount: { createdBy: input.operator, createdAt: now }
	});
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_users', recordId: accountId, action: 'CREATE_DEV_ACCOUNT',
		changedBy: input.operator.username, changedAt: now,
		newData: { accountId, name }
	});
	return { ok: true, accountId };
}

/**
 * Remove a dev account: close its open ownership rows, revoke its customer
 * links, drop any block, delete the app_users row. Refuses anything that is
 * not a dev account — real accounts are blocked, never deleted.
 */
export async function deleteDevAccount(input: { accountId: string; operator: OperatorRef }): Promise<{ ok: true } | { ok: false; error: string }> {
	const { accountId } = input;
	if (!isDevAccountId(accountId)) return { ok: false, error: 'Only dev accounts can be removed' };
	const user = await AppUser.findById(accountId).select('_id').lean();
	if (!user) return { ok: false, error: 'Account not found' };
	const now = new Date();
	const actor = { kind: 'operator' as const, id: input.operator._id, label: input.operator.username };
	const [released, revoked] = await Promise.all([
		CartridgeOwnership.updateMany(
			{ accountId, open: true },
			{ $set: { open: false, releasedAt: now, releasedBy: actor, releaseReason: 'operator', releaseNote: 'Dev account removed' } }
		),
		CustomerAccount.updateMany({ accountId, status: 'active' }, { $set: { status: 'revoked', revokedAt: now, revokedBy: actor } }),
		AppAccountBlock.deleteOne({ _id: accountId })
	]);
	await AppUser.deleteOne({ _id: accountId });
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_users', recordId: accountId, action: 'DELETE_DEV_ACCOUNT',
		changedBy: input.operator.username, changedAt: now,
		oldData: { accountId, releasedCartridges: released.modifiedCount, revokedLinks: revoked.modifiedCount }
	});
	return { ok: true };
}
