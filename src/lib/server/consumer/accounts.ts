import { AppAccountBlock, AppAccountSetting, AppUser, AuditLog, CartridgeOwnership, CustomerAccount, generateId, APP_ACCOUNT_TYPES } from '$lib/server/db';
import type { AppAccountType } from '$lib/server/db';
import type { OperatorRef } from './ownership';

// ---------------------------------------------------------------------------
// Account types and clinic enrollment (docs/CONSUMER-OWNERSHIP.md "Account
// types"). Stored in `app_account_settings`; no row = individual, not
// enrolled — the state every new account starts in.

export type AccountSettings = { accountType: AppAccountType; clinicAccountId: string | null };

export const isAccountType = (t: string): t is AppAccountType => (APP_ACCOUNT_TYPES as readonly string[]).includes(t);

const settingsOf = (doc: any): AccountSettings => {
	const accountType: AppAccountType = doc?.accountType && isAccountType(doc.accountType) ? doc.accountType : 'individual';
	return { accountType, clinicAccountId: accountType === 'individual' ? (doc?.clinicAccountId ?? null) : null };
};

export async function settingsFor(accountId: string): Promise<AccountSettings> {
	return settingsOf(await AppAccountSetting.findById(accountId).lean());
}

/** Settings for many accounts at once; missing ids are individuals. */
export async function settingsForMany(accountIds: string[]): Promise<Map<string, AccountSettings>> {
	const docs = accountIds.length ? ((await AppAccountSetting.find({ _id: { $in: accountIds } }).lean()) as any[]) : [];
	const byId = new Map(docs.map((d) => [d._id as string, settingsOf(d)]));
	return new Map(accountIds.map((id) => [id, byId.get(id) ?? settingsOf(null)]));
}

/** Individual accounts enrolled under this clinic account. */
export async function enrolledUnder(clinicAccountId: string): Promise<string[]> {
	const docs = (await AppAccountSetting.find({ clinicAccountId, accountType: 'individual' }).select('_id').lean()) as any[];
	return docs.map((d) => d._id as string);
}

/** Every clinic-type account, for the enrollment picker. */
export async function clinicAccountIds(): Promise<string[]> {
	const docs = (await AppAccountSetting.find({ accountType: 'clinic' }).select('_id').lean()) as any[];
	return docs.map((d) => d._id as string);
}

type Outcome = { ok: true; message: string } | { ok: false; error: string };

/**
 * Change an account's type. Granting or removing `dev` (every user's results)
 * needs a BIMS admin; the caller passes `isAdmin`. A clinic with enrolled
 * accounts cannot change type until they are removed, so nobody is silently
 * cut off. An individual that becomes a clinic or dev leaves its clinic.
 */
export async function setAccountType(input: {
	accountId: string; accountType: string; operator: OperatorRef; isAdmin: boolean;
}): Promise<Outcome> {
	const { accountId, operator } = input;
	if (!isAccountType(input.accountType)) return { ok: false, error: 'Unknown account type' };
	const next = input.accountType;
	const current = await settingsFor(accountId);
	if (current.accountType === next) return { ok: true, message: 'No change' };
	if ((next === 'dev' || current.accountType === 'dev') && !input.isAdmin)
		return { ok: false, error: 'Only a BIMS admin can grant or remove the Dev type — it shows every user’s results' };
	if (current.accountType === 'clinic') {
		const enrolled = await enrolledUnder(accountId);
		if (enrolled.length)
			return { ok: false, error: `Remove the ${enrolled.length} account${enrolled.length === 1 ? '' : 's'} enrolled under this clinic first` };
	}
	const leftClinic = next !== 'individual' ? current.clinicAccountId : null;
	const now = new Date();
	await AppAccountSetting.updateOne(
		{ _id: accountId },
		{
			$set: {
				accountType: next, updatedBy: operator, updatedAt: now,
				...(next !== 'individual' ? { clinicAccountId: null, enrolledAt: null, enrolledBy: null } : {})
			}
		},
		{ upsert: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_account_settings', recordId: accountId, action: 'SET_ACCOUNT_TYPE',
		changedBy: operator.username, changedAt: now,
		oldData: { accountType: current.accountType, clinicAccountId: current.clinicAccountId },
		newData: { accountType: next, clinicAccountId: next === 'individual' ? current.clinicAccountId : null }
	});
	return { ok: true, message: `Account type set to ${next}${leftClinic ? ' — it is no longer enrolled under its clinic' : ''}` };
}

/** Enroll an individual account under a clinic-type account (moves it if already enrolled elsewhere). */
export async function enrollInClinic(input: {
	accountId: string; clinicAccountId: string; operator: OperatorRef;
}): Promise<Outcome> {
	const { accountId, clinicAccountId, operator } = input;
	if (accountId === clinicAccountId) return { ok: false, error: 'An account cannot be enrolled under itself' };
	const [me, clinic, clinicUser] = await Promise.all([
		settingsFor(accountId), settingsFor(clinicAccountId), AppUser.exists({ _id: clinicAccountId })
	]);
	if (!clinicUser || clinic.accountType !== 'clinic') return { ok: false, error: 'That account is not a clinic account' };
	if (me.accountType !== 'individual') return { ok: false, error: 'Only individual accounts can be enrolled under a clinic' };
	if (me.clinicAccountId === clinicAccountId) return { ok: true, message: 'Already enrolled under that clinic' };
	const now = new Date();
	await AppAccountSetting.updateOne(
		{ _id: accountId },
		{ $set: { accountType: 'individual', clinicAccountId, enrolledAt: now, enrolledBy: operator, updatedBy: operator, updatedAt: now } },
		{ upsert: true }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_account_settings', recordId: accountId, action: 'ENROLL_IN_CLINIC',
		changedBy: operator.username, changedAt: now,
		oldData: { clinicAccountId: me.clinicAccountId }, newData: { clinicAccountId }
	});
	return { ok: true, message: me.clinicAccountId ? 'Moved to the new clinic' : 'Enrolled — the clinic now sees this account’s results' };
}

export async function removeFromClinic(input: { accountId: string; operator: OperatorRef }): Promise<Outcome> {
	const { accountId, operator } = input;
	const me = await settingsFor(accountId);
	if (!me.clinicAccountId) return { ok: false, error: 'This account is not enrolled under a clinic' };
	const now = new Date();
	await AppAccountSetting.updateOne(
		{ _id: accountId },
		{ $set: { clinicAccountId: null, enrolledAt: null, enrolledBy: null, updatedBy: operator, updatedAt: now } }
	);
	await AuditLog.create({
		_id: generateId(),
		tableName: 'app_account_settings', recordId: accountId, action: 'REMOVE_FROM_CLINIC',
		changedBy: operator.username, changedAt: now,
		oldData: { clinicAccountId: me.clinicAccountId }, newData: { clinicAccountId: null }
	});
	return { ok: true, message: 'Removed from the clinic — it no longer sees this account’s results' };
}

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
		AppAccountBlock.deleteOne({ _id: accountId }),
		AppAccountSetting.deleteOne({ _id: accountId }),
		AppAccountSetting.updateMany({ clinicAccountId: accountId }, { $set: { clinicAccountId: null, enrolledAt: null, enrolledBy: null, updatedBy: input.operator, updatedAt: now } })
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
