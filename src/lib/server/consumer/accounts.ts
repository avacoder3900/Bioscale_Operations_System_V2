import { AppAccountBlock, AuditLog, generateId } from '$lib/server/db';
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
